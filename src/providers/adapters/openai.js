// OpenAI-compatible adapter — passthrough for OpenRouter, OpenAI, Groq, Together, Ollama
// This is the current format used by client.js, extracted as an adapter.

export function buildHeaders(provider, apiKey) {
  const headers = {
    "Content-Type": "application/json",
    ...provider.headers,
  };
  if (provider.authType === "bearer" && apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }
  return headers;
}

// `extra` carries what a particular caller needs and the main loop does not:
// a pinned seed and json_object for the classifier, temperature 0 for anything
// that parses its own answer. It arrives here rather than in a second fetch
// somewhere because there is one door now.
export function buildBody(messages, model, tools, maxTokens, stream, extra = {}) {
  const body = { model, messages, stream };
  if (maxTokens) body.max_tokens = maxTokens;
  if (tools?.length) body.tools = tools;
  if (extra.temperature != null) body.temperature = extra.temperature;
  if (extra.seed != null) body.seed = extra.seed;
  if (extra.responseFormat) body.response_format = extra.responseFormat;
  return body;
}

export function getChatUrl(provider) {
  if (provider.ollamaCompat) {
    return `${provider.baseUrl}/v1/chat/completions`;
  }
  return `${provider.baseUrl}/chat/completions`;
}

// Parse streaming response — same as current client.js logic
//
// `onProgress({ kind, chars })` is called for what the model sends that is not
// text: "reasoning" and "tool" (a tool call being written). A long file
// written in one tool call is a stream of argument chunks and no text at all,
// and a caller that watched only onToken took a working model for a hung
// connection. A router's keep-alive comment is not progress: parseSSE
// drops it, and it says the router is up, not that the model is working.
export async function parseStreamResponse(response, onToken, onProgress) {
  let content = "";
  const toolCalls = new Map();
  let generationId = null;
  let usage = null;
  // Which model answered: with a fallback list (free mode) it may not be the
  // one asked for.
  let servedModel = null;

  for await (const chunk of parseSSE(response.body)) {
    if (chunk.id && !generationId) generationId = chunk.id;
    if (chunk.model && !servedModel) servedModel = chunk.model;
    if (chunk.usage) usage = chunk.usage;

    const delta = chunk.choices?.[0]?.delta;
    if (!delta) continue;

    if (delta.content) {
      content += delta.content;
      onToken?.(delta.content);
    }

    // One model's reasoning arrives under one of three names; Gemini through
    // OpenRouter withholds the text and still sends the block.
    const reasoning = delta.reasoning || delta.reasoning_content;
    if (reasoning || delta.reasoning_details) {
      onProgress?.({ kind: "reasoning", chars: typeof reasoning === "string" ? reasoning.length : 0 });
    }

    if (delta.tool_calls) {
      let chars = 0;
      for (const tc of delta.tool_calls) {
        chars += (tc.function?.name?.length || 0) + (tc.function?.arguments?.length || 0);
        const idx = tc.index;
        if (!toolCalls.has(idx)) {
          toolCalls.set(idx, { id: "", type: "function", function: { name: "", arguments: "" } });
        }
        const existing = toolCalls.get(idx);
        if (tc.id) existing.id = tc.id;
        if (tc.function?.name) existing.function.name += tc.function.name;
        if (tc.function?.arguments) existing.function.arguments += tc.function.arguments;
        // Gemini 3 (OpenAI-compat) attaches a per-call thought signature as
        // extra_content; the next request 400s (missing thought_signature)
        // unless it is echoed back verbatim. Preserve every non-standard field
        // of the delta call instead of rebuilding a minimal object.
        for (const k of Object.keys(tc)) {
          if (!["index", "id", "type", "function"].includes(k)) existing[k] = tc[k];
        }
      }
      onProgress?.({ kind: "tool", chars });
    }
  }

  const message = { role: "assistant", content: content || "" };
  if (toolCalls.size > 0) {
    message.tool_calls = [...toolCalls.values()];
  }
  return { message, usage, generationId, servedModel };
}

// Parse non-streaming response
export function parseResponse(data, onToken) {
  const choice = data.choices?.[0];
  // The same fields a streamed answer is built from, and no others. The
  // provider's message also carries the model's reasoning (`reasoning`,
  // `reasoning_details`), and kept whole it went into the history, back to
  // the provider on every later call, and past every budget, which count the
  // text and the tool calls: in one session it was two and a half times the
  // size of the answers themselves. What a provider needs returned to carry
  // on from a tool call travels on the call, and the calls are kept as sent.
  const raw = choice?.message || {};
  const message = { role: "assistant", content: raw.content || "" };
  if (raw.tool_calls?.length) message.tool_calls = raw.tool_calls;
  if (message.content) onToken?.(message.content);
  return { message, usage: data.usage || null, generationId: data.id || null, servedModel: data.model || null };
}

async function* parseSSE(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n");
    buffer = parts.pop();

    for (const line of parts) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (data === "[DONE]") return;
      try {
        yield JSON.parse(data);
      } catch {
        // skip malformed chunks
      }
    }
  }
}
