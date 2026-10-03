// Stream pipe — per-message event emitter for SSE streaming.
//
// When a message is processed with stream=true, the drain loop attaches
// callbacks (onToken, onToolStart, onToolResult) that emit events here.
// The HTTP server subscribes and forwards as Server-Sent Events.
//
// Internal task reference removed.

import { EventEmitter } from "node:events";

const _pipes = new Map(); // messageId → EventEmitter

/**
 * Create a stream pipe for a message.
 * @param {string} messageId
 * @returns {EventEmitter}
 */
export function createPipe(messageId) {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(5);
  _pipes.set(messageId, emitter);
  return emitter;
}

/**
 * Get existing pipe for a message.
 * @param {string} messageId
 * @returns {EventEmitter|null}
 */
export function getPipe(messageId) {
  return _pipes.get(messageId) || null;
}

/**
 * Close and remove a pipe.
 * @param {string} messageId
 */
export function closePipe(messageId) {
  const pipe = _pipes.get(messageId);
  if (pipe) {
    pipe.emit("end");
    pipe.removeAllListeners();
    _pipes.delete(messageId);
  }
}

/**
 * Create SSE callback handlers for agent loop.
 * Attach to processMessage options to pipe events to SSE client.
 * @param {string} messageId
 * @returns {{ onToken, onToolStart, onToolResult, onStreamEnd }}
 */
export function createStreamCallbacks(messageId) {
  const pipe = getPipe(messageId);
  if (!pipe) return {};

  return {
    onToken: (token) => {
      pipe.emit("event", { type: "token", data: token });
    },
    onToolStart: (toolName, args) => {
      pipe.emit("event", { type: "tool_start", data: { tool: toolName, args } });
    },
    onToolResult: (toolName, result) => {
      const short = typeof result === "string" ? result.slice(0, 500) : JSON.stringify(result).slice(0, 500);
      pipe.emit("event", { type: "tool_result", data: { tool: toolName, result: short } });
    },
    onStreamEnd: () => {
      pipe.emit("event", { type: "stream_end", data: {} });
    },
  };
}

/**
 * Write SSE events to HTTP response from a pipe.
 * @param {EventEmitter} pipe
 * @param {http.ServerResponse} res
 * @param {string} messageId
 */
export function pipeToResponse(pipe, res, messageId) {
  // SSE headers
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Message-Id": messageId,
  });

  const onEvent = ({ type, data }) => {
    const payload = JSON.stringify({ type, data, ts: Date.now() });
    res.write(`event: ${type}\ndata: ${payload}\n\n`);
  };

  const onEnd = () => {
    res.write(`event: done\ndata: ${JSON.stringify({ type: "done", ts: Date.now() })}\n\n`);
    res.end();
    cleanup();
  };

  const cleanup = () => {
    pipe.off("event", onEvent);
    pipe.off("end", onEnd);
  };

  pipe.on("event", onEvent);
  pipe.on("end", onEnd);

  // Client disconnect cleanup
  res.on("close", () => {
    cleanup();
    closePipe(messageId);
  });
}
