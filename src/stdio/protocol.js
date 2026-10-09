// The stream-json protocol of the stdio mode: one JSON object per line on
// stdin and on stdout. The lines a host written for
// `claude --input-format stream-json --output-format stream-json` knows keep
// the common stream-json shapes:
//
//   system (init)         session_id, model, cwd, tools, mcp_servers, permissionMode
//   assistant             message.content[] text and tool_use blocks, message.usage, message.id
//   user (tool_result)    tool_use_id, content, is_error
//   result                subtype, result, usage, total_cost_usd, stop_reason
//   control_response      the answer to a control_request
//
// Flint adds to that, and this is NOT part of the claude stream-json format:
//
//   tool_start            tool_use_id, tool_name, args: a tool begins
//   text                  text: one streamed chunk of the reply, thinking left
//                         out; the same text comes again, whole, in `assistant`
//   text_delta            delta: visible prose before the assistant snapshot
//   steer_status          request_id, status "delivered" | "too_late" (after the
//                         control_response that said "accepted")
//   on the tool_result line, beside `message`: tool_name, args, duration_ms
//   on the result line: truncated_at, provider_error
//
// So a host has to skip a line whose `type` it does not know and ignore fields
// it does not know; one that rejects them cannot read Flint as it is. The node
// host reads the added types (tests/integration/stdio-event-stream.test.js,
// docs/findings/stdio-event-stream.md), which is why they are always on.
//
// A host writes `user` messages and `control_request` interrupts or steers.
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

export function toolResultEvent({ toolUseId, result, isError, sessionId, toolName, args, durationMs }) {
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
    tool_name: toolName || null,
    args: args || {},
    duration_ms: durationMs || 0,
  };
}

/**
 * The end of a turn. `subtype` is "success", "error_during_execution" (the
 * turn failed or was interrupted) or "error_max_turns" (the step limit).
 */
export function resultEvent({ subtype, text, sessionId, durationMs, numTurns, costUsd, promptTokens, completionTokens, stopReason, truncatedAt, providerError }) {
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
    // Structured marker for a turn cut by the step ceiling (max_iterations).
    // null on a normal completion so hosts don't have to distinguish key
    // presence from absence.
    truncated_at: truncatedAt || null,
    // The provider's definite verdict on this turn ({ status, kind }, kind
    // "model-not-found" or "auth"), else null. Structured, so a host never has
    // to read it out of the text or the stderr.
    provider_error: providerError || null,
  };
}

/**
 * A tool started. The stream-json host needs to know immediately when a tool
 * begins, not only when its result arrives, so it can mark the turn active
 * and show what is running. Carries the call's id (the id of its tool_use
 * block and of its tool_result; null when the call has none), the tool name
 * and its arguments; duration_ms and result come in the matching tool_result.
 */
export function toolStartEvent({ toolUseId, toolName, args, sessionId }) {
  return {
    type: "tool_start",
    tool_use_id: toolUseId || null,
    tool_name: toolName,
    args: args || {},
    session_id: sessionId,
  };
}

/**
 * A chunk of streamed model output. Emitted for every token the model
 * produces, so a host does not have to wait for the assembled reply.
 */
export function textEvent({ text, sessionId }) {
  return {
    type: "text",
    text: text || "",
    session_id: sessionId,
  };
}

export function controlResponse(requestId, extra = {}) {
  return { type: "control_response", response: { subtype: "success", request_id: requestId, response: extra } };
}

export function controlError(requestId, error) {
  return { type: "control_response", response: { subtype: "error", request_id: requestId, error } };
}

export function steerStatus(requestId, status, sessionId) {
  return { type: "steer_status", request_id: requestId, status, session_id: sessionId };
}

export function textDelta(delta, sessionId) {
  return { type: "text_delta", delta, session_id: sessionId };
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
