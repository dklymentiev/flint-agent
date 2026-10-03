// The stream-json protocol of the stdio mode: one JSON object per line on
// stdin and on stdout, in the common stream-json shapes, so a host written for
// `claude --input-format stream-json --output-format stream-json` reads Flint
// without changes. A host driving it reads:
//
//   assistant  message.content[] text and tool_use blocks, message.usage, message.id
//   result     subtype ("success" or an error), result, usage, total_cost_usd
//   error      message (a turn that could not run at all)
//
// and writes `user` messages and `control_request` interrupts. Everything else
// (system init, tool results, control responses) is for other hosts and logs.
//
// Pure functions only; the loop that uses them is stdio/run.js.

/** A tool result line is for logs; the model already has the full text. */
export const TOOL_RESULT_MAX_CHARS = 16000;

/** Parse one input line. Null for a blank or non-JSON line, which is skipped. */
export function parseInputLine(line) {
  const s = String(line || "").trim();
  if (!s) return null;
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

/**
 * The content of a `user` envelope as Flint's processMessage takes it: a
 * string when it is only text, else OpenAI-style parts with images as data
 * URLs. Null when the envelope carries nothing to answer.
 */
export function userContent(envelope) {
  const content = envelope?.message?.content;
  if (typeof content === "string") return content.trim() ? content : null;
  if (!Array.isArray(content)) return null;
  const parts = [];
  for (const b of content) {
    if (!b || typeof b !== "object") continue;
    if (b.type === "text" && b.text) parts.push({ type: "text", text: String(b.text) });
    else if (b.type === "image" && b.source?.type === "base64" && b.source.data) {
      parts.push({ type: "image_url", image_url: { url: `data:${b.source.media_type || "image/png"};base64,${b.source.data}` } });
    } else if (b.type === "image" && b.source?.type === "url" && b.source.url) {
      parts.push({ type: "image_url", image_url: { url: b.source.url } });
    }
  }
  if (!parts.length) return null;
  if (parts.every((p) => p.type === "text")) return parts.map((p) => p.text).join("\n\n");
  return parts;
}

function toolInput(args) {
  if (args && typeof args === "object") return args;
  try {
    const v = JSON.parse(args || "{}");
    return v && typeof v === "object" ? v : { value: v };
  } catch {
    return { raw: String(args) };
  }
}

function usageOf(usage) {
  return {
    input_tokens: usage?.prompt_tokens || 0,
    output_tokens: usage?.completion_tokens || 0,
    cache_read_input_tokens: usage?.prompt_tokens_details?.cached_tokens || 0,
    cache_creation_input_tokens: 0,
  };
}

export function initEvent({ sessionId, model, cwd, tools = [], mcpServers = [], permissionMode, version }) {
  return {
    type: "system",
    subtype: "init",
    session_id: sessionId,
    cwd,
    model,
    tools,
    mcp_servers: mcpServers,
    permissionMode,
    agent: "flint",
    version,
  };
}

/**
 * One model reply as an `assistant` message: its text, then one tool_use block
 * per tool call. Null for a reply with neither.
 */
export function assistantEvent({ reply, usage, model, sessionId, messageId }) {
  const content = [];
  const text = typeof reply?.content === "string" ? reply.content.trim() : "";
  if (text) content.push({ type: "text", text });
  for (const tc of reply?.tool_calls || []) {
    content.push({ type: "tool_use", id: tc.id, name: tc.function?.name, input: toolInput(tc.function?.arguments) });
  }
  if (!content.length) return null;
  return {
    type: "assistant",
    message: {
      id: messageId,
      type: "message",
      role: "assistant",
      model,
      content,
      stop_reason: reply?.tool_calls?.length ? "tool_use" : "end_turn",
      usage: usageOf(usage),
    },
    parent_tool_use_id: null,
    session_id: sessionId,
  };
}

export function toolResultEvent({ toolUseId, result, isError, sessionId }) {
  let text = typeof result === "string" ? result : JSON.stringify(result);
  if (text == null) text = "";
  if (text.length > TOOL_RESULT_MAX_CHARS) {
    text = text.slice(0, TOOL_RESULT_MAX_CHARS) + `\n[... ${text.length - TOOL_RESULT_MAX_CHARS} more characters]`;
  }
  return {
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: text, is_error: !!isError }] },
    parent_tool_use_id: null,
    session_id: sessionId,
  };
}

/**
 * The end of a turn. `subtype` is "success", "error_during_execution" (the
 * turn failed or was interrupted) or "error_max_turns" (the step limit).
 */
export function resultEvent({ subtype, text, sessionId, durationMs, numTurns, costUsd, promptTokens, completionTokens, stopReason }) {
  return {
    type: "result",
    subtype,
    is_error: subtype !== "success",
    duration_ms: durationMs,
    num_turns: numTurns,
    result: text || "",
    session_id: sessionId,
    total_cost_usd: costUsd || 0,
    usage: { input_tokens: promptTokens || 0, output_tokens: completionTokens || 0 },
    stop_reason: stopReason || null,
  };
}

export function controlResponse(requestId, extra = {}) {
  return { type: "control_response", response: { subtype: "success", request_id: requestId, response: extra } };
}

export function controlError(requestId, error) {
  return { type: "control_response", response: { subtype: "error", request_id: requestId, error } };
}

/**
 * Which result subtype a finished processMessage maps to. Flint's own stop
 * reasons (agent/agent.js): "done"; "denied" (it stopped asking after
 * repeated denials and said so, an answer like any other); "budget" (the
 * cost ceiling); "error", "stall", "empty" (the turn did not get anywhere).
 */
export function resultSubtype(stopReason) {
  if (!stopReason || stopReason === "done" || stopReason === "denied") return "success";
  if (stopReason === "budget") return "error_max_budget_usd";
  return "error_during_execution";
}
