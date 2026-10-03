// The stdio mode's session logic, kept free of the agent's own modules so it
// can be tested alone: the host's instructions (CLAUDE.md and the prompt
// flags), the MCP config file, and the loop that turns input lines into turns
// and turns into protocol lines. stdio/run.js wires it to the agent.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  parseInputLine, userContent, assistantEvent, toolResultEvent,
  resultEvent, resultSubtype, controlResponse,
} from "./protocol.js";

/**
 * CLAUDE.md files an agent in this folder is expected to read: the folder's
 * own and every parent's, outermost first. A host may keep an agent's role
 * there and shared rules one level up.
 */
export function claudeMdChain(cwd) {
  const found = [];
  let dir = path.resolve(cwd);
  for (;;) {
    const f = path.join(dir, "CLAUDE.md");
    if (existsSync(f)) found.unshift(f);
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return found;
}

/**
 * The host's instructions, in the order they apply: --system-prompt (or its
 * file), the CLAUDE.md chain, then --append-system-prompt (or its file).
 */
export function hostPromptFrom(opts, { cwd = process.cwd(), read = (f) => readFileSync(f, "utf8") } = {}) {
  const parts = [];
  if (opts.systemPrompt) parts.push(opts.systemPrompt);
  if (opts.systemPromptFile) parts.push(read(opts.systemPromptFile));
  for (const f of claudeMdChain(cwd)) {
    const text = read(f).trim();
    if (text) parts.push(`<instructions source="${f}">\n${text}\n</instructions>`);
  }
  if (opts.appendSystemPrompt) parts.push(opts.appendSystemPrompt);
  if (opts.appendSystemPromptFile) parts.push(read(opts.appendSystemPromptFile));
  const body = parts.map((p) => String(p).trim()).filter(Boolean).join("\n\n");
  if (!body) return "";
  // Without this line the model kept the core prompt's "You are FLINT" over
  // the host's role: a test agent told to answer "Pebble" answered "FLINT."
  // (2026-10-02). An agent's CLAUDE.md is who it is.
  return "The program running you gave you the identity, role and rules below. " +
    "They take precedence over the defaults above: where they name you, give you a role, " +
    "or say how to answer, follow them.\n\n" + body;
}

/** The MCP config file to load: --mcp-config, else .mcp.json in the folder. */
export function mcpConfigPath(opts, cwd = process.cwd()) {
  if (opts.mcpConfig) return path.resolve(cwd, opts.mcpConfig);
  const local = path.join(cwd, ".mcp.json");
  return existsSync(local) ? local : null;
}

/**
 * Turns one session's lines into turns. `write` takes one protocol object;
 * `run` runs one turn (processMessage); both are injectable for tests.
 */
export function createStdioSession({ write, run, sessionId, model, onIdleEnd, onInterrupted }) {
  const modelName = typeof model === "function" ? model : () => model;
  const queue = [];
  let current = null;       // { controller, interrupted }
  let busy = false;
  let ended = false;
  let turnNo = 0;

  async function runTurn(content) {
    turnNo++;
    const controller = new AbortController();
    current = { controller, interrupted: false };
    const started = Date.now();
    let apiCalls = 0;
    let toolSeq = 0;
    const pendingIds = new Map();   // tool name -> ids of its calls not yet answered

    const observer = {
      onReply(reply, usage) {
        apiCalls++;
        for (const tc of reply?.tool_calls || []) {
          if (!tc.id) tc.id = `toolu_flint_${turnNo}_${++toolSeq}`;
          const name = tc.function?.name;
          if (!pendingIds.has(name)) pendingIds.set(name, []);
          pendingIds.get(name).push(tc.id);
        }
        const ev = assistantEvent({ reply, usage, model: modelName(), sessionId, messageId: `msg_flint_${turnNo}_${apiCalls}` });
        if (ev) write(ev);
      },
      onToolResult(name, result, denied) {
        const id = pendingIds.get(name)?.shift() || `toolu_flint_${turnNo}_${++toolSeq}`;
        const text = typeof result === "string" ? result : JSON.stringify(result);
        const isError = !!denied || /^(error|\[error)/i.test(String(text || "").trim());
        write(toolResultEvent({ toolUseId: id, result: text, isError, sessionId }));
      },
    };

    let ev;
    try {
      const res = await run(content, { signal: controller.signal, observer });
      const stats = res?.stats || {};
      const subtype = current.interrupted ? "error_during_execution" : resultSubtype(res?.stop_reason);
      ev = resultEvent({
        subtype,
        text: res?.text || "",
        sessionId,
        durationMs: Date.now() - started,
        numTurns: apiCalls,
        costUsd: stats.cost,
        promptTokens: stats.promptTokens,
        completionTokens: stats.completionTokens,
        stopReason: current.interrupted ? "interrupted" : (res?.stop_reason || "done"),
      });
    } catch (err) {
      const interrupted = current.interrupted || err?.name === "AbortError";
      ev = resultEvent({
        subtype: "error_during_execution",
        text: interrupted ? "" : `Error: ${err?.message || err}`,
        sessionId,
        durationMs: Date.now() - started,
        numTurns: apiCalls,
        stopReason: interrupted ? "interrupted" : "error",
      });
    } finally {
      if (current?.interrupted) {
        try { await onInterrupted?.(); } catch {}
      }
      current = null;
    }
    write(ev);
  }

  async function pump() {
    if (busy) return;
    busy = true;
    try {
      while (queue.length) await runTurn(queue.shift());
    } finally {
      busy = false;
    }
    if (ended) onIdleEnd?.();
  }

  return {
    /** One input line. */
    line(raw) {
      const msg = parseInputLine(raw);
      if (!msg) return;
      if (msg.type === "user") {
        const content = userContent(msg);
        if (content == null) return;
        queue.push(content);
        pump();
        return;
      }
      if (msg.type === "control_request") {
        const subtype = msg.request?.subtype;
        if (subtype === "interrupt" && current) {
          current.interrupted = true;
          current.controller.abort(new Error("interrupted by host"));
        }
        // Every request is answered, so a host waiting on one never hangs:
        // interrupt with nothing running, initialize, and the requests Flint
        // has no use for all get a plain success.
        write(controlResponse(msg.request_id ?? null));
      }
    },
    /** stdin closed: finish what is queued, then end. */
    end() {
      ended = true;
      if (!busy) onIdleEnd?.();
    },
    get busy() { return busy; },
  };
}
