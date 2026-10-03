// Anthropic Messages API adapter
// Transforms OpenAI-format messages ↔ Anthropic format

export function buildHeaders(provider, apiKey) {
  return {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
    ...provider.headers,
  };
}

export function getChatUrl(provider) {
  return `${provider.baseUrl}/messages`;
}

// Convert OpenAI-style messages to Anthropic format
function convertMessages(messages) {
  let systemPrompt = "";
  const converted = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      // System messages → top-level system param
      systemPrompt += (systemPrompt ? "\n\n" : "") + (typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content));
      continue;
    }

    if (msg.role === "assistant") {
      if (msg.tool_calls?.length) {
        // Assistant with tool_calls → content blocks with tool_use
        const content = [];
        if (msg.content) {
          content.push({ type: "text", text: msg.content });
        }
        for (const tc of msg.tool_calls) {
          let args = tc.function.arguments;
          if (typeof args === "string") {
            try { args = JSON.parse(args); } catch { args = {}; }
          }
          content.push({
            type: "tool_use",
            id: tc.id,
            name: tc.function.name,
            input: args,
          });
        }
        converted.push({ role: "assistant", content });
      } else {
        converted.push({ role: "assistant", content: msg.content || "" });
      }
      continue;
    }

    if (msg.role === "tool") {
      // Tool result → content block with tool_result
      converted.push({
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: msg.tool_call_id,
          content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
        }],
      });
      continue;
    }

    if (msg.role === "user") {
      // User messages — handle multimodal content
      if (Array.isArray(msg.content)) {
        const content = msg.content.map((part) => {
          if (part.type === "text") return { type: "text", text: part.text };
          if (part.type === "image_url") {
            const url = part.image_url?.url || "";
            if (url.startsWith("data:")) {
              const match = url.match(/^data:(image\/\w+);base64,(.+)$/);
              if (match) {
                return {
                  type: "image",
                  source: { type: "base64", media_type: match[1], data: match[2] },
                };
              }
            }
            return { type: "text", text: `[Image: ${url}]` };
          }
          return part;
        });
        converted.push({ role: "user", content });
      } else {
        converted.push({ role: "user", content: msg.content });
      }
      continue;
    }
  }

  // Anthropic requires alternating user/assistant. Merge consecutive same-role messages.
  const merged = [];
  for (const msg of converted) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === msg.role) {
      // Merge content
      const prevContent = Array.isArray(prev.content)
        ? prev.content
        : [{ type: "text", text: prev.content }];
      const newContent = Array.isArray(msg.content)
        ? msg.content
        : [{ type: "text", text: msg.content }];
      prev.content = [...prevContent, ...newContent];
    } else {
      merged.push({ ...msg });
    }
  }

  return { system: systemPrompt || undefined, messages: merged };
}

// Convert OpenAI tool definitions to Anthropic format
function convertTools(tools) {
  if (!tools?.length) return undefined;
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description || "",
    input_schema: t.function.parameters || { type: "object", properties: {} },
  }));
}

// `extra`: see the openai adapter. Anthropic has no `seed` and no
// `response_format`, so a caller that asked for JSON gets ordinary text here
// and has to find the JSON in it. Every caller that asks already does — models
// ignored the flag often enough to make that necessary anyway.
export function buildBody(messages, model, tools, maxTokens, stream, extra = {}) {
  const { system, messages: converted } = convertMessages(messages);
  const body = {
    model,
    messages: converted,
    max_tokens: maxTokens || 4096,
    stream,
  };
  if (extra.temperature != null) body.temperature = extra.temperature;
  if (system) body.system = system;
  const convertedTools = convertTools(tools);
  if (convertedTools) body.tools = convertedTools;
  return body;
}

// Parse non-streaming response
export function parseResponse(data, onToken) {
  const content = data.content || [];
  let text = "";
  const toolCalls = [];

  for (const block of content) {
    if (block.type === "text") {
      text += block.text;
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        type: "function",
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input || {}),
        },
      });
    }
  }

  if (text) onToken?.(text);

  const message = { role: "assistant", content: text };
  if (toolCalls.length) message.tool_calls = toolCalls;

  const usage = data.usage ? {
    prompt_tokens: data.usage.input_tokens,
    completion_tokens: data.usage.output_tokens,
    total_tokens: (data.usage.input_tokens || 0) + (data.usage.output_tokens || 0),
  } : null;

  return { message, usage, generationId: data.id || null };
}

// Parse streaming response (Anthropic SSE format)
export async function parseStreamResponse(response, onToken) {
  let text = "";
  const toolCalls = new Map(); // index → { id, name, arguments }
  let currentToolIndex = -1;
  let generationId = null;
  let usage = null;

  for await (const event of parseAnthropicSSE(response.body)) {
    if (event.type === "message_start") {
      generationId = event.message?.id || null;
      if (event.message?.usage) {
        usage = {
          prompt_tokens: event.message.usage.input_tokens || 0,
          completion_tokens: 0,
          total_tokens: 0,
        };
      }
    } else if (event.type === "content_block_start") {
      if (event.content_block?.type === "tool_use") {
        currentToolIndex++;
        toolCalls.set(currentToolIndex, {
          id: event.content_block.id,
          type: "function",
          function: {
            name: event.content_block.name,
            arguments: "",
          },
        });
      }
    } else if (event.type === "content_block_delta") {
      const delta = event.delta;
      if (delta?.type === "text_delta") {
        text += delta.text;
        onToken?.(delta.text);
      } else if (delta?.type === "input_json_delta") {
        if (toolCalls.has(currentToolIndex)) {
          toolCalls.get(currentToolIndex).function.arguments += delta.partial_json;
        }
      }
    } else if (event.type === "message_delta") {
      if (event.usage) {
        const outTokens = event.usage.output_tokens || 0;
        if (usage) {
          usage.completion_tokens = outTokens;
          usage.total_tokens = usage.prompt_tokens + outTokens;
        }
      }
    }
  }

  const message = { role: "assistant", content: text };
  if (toolCalls.size > 0) {
    message.tool_calls = [...toolCalls.values()];
  }
  return { message, usage, generationId };
}

async function* parseAnthropicSSE(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop();

    let eventType = null;
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("event:")) {
        eventType = trimmed.slice(6).trim();
      } else if (trimmed.startsWith("data:")) {
        const data = trimmed.slice(5).trim();
        try {
          const parsed = JSON.parse(data);
          if (eventType) parsed.type = eventType;
          yield parsed;
        } catch {}
        eventType = null;
      } else if (!trimmed) {
        eventType = null;
      }
    }
  }
}
