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
export async function parseStreamResponse(response, onToken) {
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

    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
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
  const message = choice?.message || { role: "assistant", content: "" };
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
