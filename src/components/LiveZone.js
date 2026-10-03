// The live zone: the only part of the console that is redrawn.
//
// docs/console-spec.md. Ink clears the whole terminal and reprints history on
// every render once its live output is as tall as the window
// (node_modules/ink/build/ink.js:322). Everything here is one row per item and
// bounded, so the zone stays a few rows high at any terminal size.
//
//   activity  what Flint is doing, or the line of the answer being written
//   confirm   a pending approval or pairing (only when there is one)
//   dock      running background processes, at most DOCK_ROWS
//   --------
//   input     (App)
//   status    one row

import React from "react";
import { Box, Text } from "ink";
import { formatStatusLevel } from "../ui/status-level.js";
import { toolCategory, ledgerWidth, fitMiddle } from "../ui/tool-ledger.js";
import wrapAnsi from "wrap-ansi";

const { createElement: h } = React;

export const DOCK_ROWS = 3;

/**
 * Seconds as m:ss. A bare 468 is not obviously nine minutes, and 468 was what
 * the status line showed for a hung call on 2026-09-29.
 */
export function formatElapsed(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}


// The footer's activity block (owner, 2026-10-01): fixed width, so the footer
// never shifts, and nothing in it but a spinner, a verb, the clock and the
// token count. What is being run goes in the window above (liveToolText).
//
//   · ready                          idle
//   ⠚ thinking  00:03                waiting for the model
//   ⠓ writing   00:07   ↓ 312 tok    the model is answering
//   ⠋ running   01:23                a tool is running
// A 2x2 square of dots in one character, a gap running round it clockwise
// (the owner's pick, 2026-10-01). Idle: a dot and "ready". The full square
// and "waiting" it had first read as a spinner stuck on a busy agent, twice
// (owner, 2026-10-02): idle must not look like any frame of the spinner.
const SQUARE_FRAMES = ["⠚", "⠓", "⠋", "⠙"];
export const SPINNER_FRAME_MS = 150;
export const IDLE_MARK = "·";
// Kept for the App's redraw interval.
export const DOTS_FRAME_MS = SPINNER_FRAME_MS;

/** The rotating square of dots at a moment in time. */
export function spinnerFrame(now = Date.now()) {
  return SQUARE_FRAMES[Math.floor(now / SPINNER_FRAME_MS) % SQUARE_FRAMES.length];
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;

const VERB_WIDTH = 9;
const TOKENS_WIDTH = 10;
export const ACTIVITY_BLOCK_WIDTH = 2 + VERB_WIDTH + 1 + 5 + 1 + TOKENS_WIDTH;

/** One word for what Flint is doing. */
export function activityVerb(state) {
  if (!state.agentStatus || state.agentStatus === "idle") return "ready";
  switch (state.activity?.kind) {
    case "start": return "starting";
    case "call": return "thinking";
    case "answering": return "writing";
    case "tool": return "running";
    case "stall": return "stalled";
    case "wait": return "retrying";
    default: return state.agentStatus === "calling-tool" ? "running" : "thinking";
  }
}

function clock(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/** The fixed-width block that leads the footer, idle or busy. */
export function activityText(state, now = Date.now()) {
  const busy = state.agentStatus && state.agentStatus !== "idle";
  const mark = busy ? spinnerFrame(now) : IDLE_MARK;
  const verb = activityVerb(state).padEnd(VERB_WIDTH);
  if (!busy) return `${mark} ${verb}`.padEnd(ACTIVITY_BLOCK_WIDTH);
  const since = state.activity ? state.activityStartedAt : state.startedAt;
  const time = since ? clock(now - since) : "     ";
  const tokens = state.activityTokens || 0;
  const tok = tokens > 0 ? `↓ ${tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : tokens} tok` : "";
  return `${mark} ${verb} ${time} ${tok.padStart(TOKENS_WIDTH)}`.padEnd(ACTIVITY_BLOCK_WIDTH);
}

/**
 * The running tool, in the window above the input, in the ledger's style:
 * category, verb, argument, and the latest output line. "" when no tool runs.
 * When the tool finishes, its ledger line replaces this in the history.
 */
export function liveToolText(state, columns = process.stdout.columns || 80) {
  const a = state.activity;
  if (!a || a.kind !== "tool" || !state.agentStatus || state.agentStatus === "idle") return "";
  const [cat, verb] = toolCategory(a.tool || state.currentTool || "");
  const width = ledgerWidth(columns);
  const head = `      ${cat.padEnd(6)}${verb.padEnd(8)}`;
  const detail = state.activityDetail ? String(state.activityDetail).replace(ANSI, "") : "";
  // The command wins the room; the output line takes what is left and the
  // row's own truncation cuts it at the edge.
  const argRoom = Math.max(10, width - head.length - 12);
  const arg = fitMiddle(a.arg || "", Math.min(argRoom, [...(a.arg || "")].length || 1)).trimEnd();
  return detail ? `${head}${arg}  | ${detail}` : `${head}${arg}`;
}

/** The confirm row, or "" when nothing waits for the operator. */
// An approval shows the whole command, never a cut one: a dangerous part may
// sit exactly where it would be cut (owner, 2026-10-01). Up to this many
// wrapped rows go in the live zone; a longer command is printed in full into
// the history when the question is asked (bootstrap.js) and pointed to here.
export const APPROVAL_MAX_ROWS = 6;

/**
 * Whether an approval's wrapped command is shown in the live zone (true) or
 * printed in full into the history with a pointer here (false). One rule for
 * both places, so a command is never neither. While a question waits the input
 * is one row, so this always fits the live zone's budget.
 */
export function approvalFitsLive(lineCount, rows = process.stdout.rows || 24) {
  return lineCount <= Math.min(APPROVAL_MAX_ROWS, Math.max(1, rows - 12));
}

/** The arguments of an approval, wrapped to the window, indented, nothing cut. */
export function approvalArgLines(argsText, columns = process.stdout.columns || 80) {
  const text = String(argsText || "");
  if (!text) return [];
  const width = Math.max(20, columns - 1 - 4);
  return wrapAnsi(text, width, { hard: true, trim: false }).split("\n").map((l) => `    ${l}`);
}

/** The approval or pairing rows of the live zone; [] when nothing waits. */
export function confirmRows(state, now = Date.now(), columns = process.stdout.columns || 80) {
  if (state.pendingPairing) {
    const p = state.pendingPairing;
    const left = Math.max(0, Math.ceil((p.expiresAt - now) / 1000));
    const who = p.agentName ? `${p.agentName}@${p.fromAddress}` : p.fromAddress;
    return [`  [!] Pairing from ${who}: PIN ${p.pin} (${left}s). Type "C" to cancel.`];
  }
  if (state.pendingConfirmation) {
    const head = `  ? ${state.pendingConfirmation}    [y] yes  [n] no  [a] always`;
    const lines = approvalArgLines(state.pendingConfirmationArgs, columns);
    if (approvalFitsLive(lines.length)) return [head, ...lines];
    return [head, `    full command printed above ↑ (${lines.length} lines)`];
  }
  return [];
}

/** The first approval row, for callers that want one line. */
export function confirmText(state, now = Date.now(), columns) {
  return confirmRows(state, now, columns)[0] || "";
}

/** Running background processes, newest first, at most `limit` rows. */
export function dockRows(processes, limit = DOCK_ROWS) {
  const running = (processes || []).filter((p) => p.status === "running").sort((a, b) => b.id - a.id);
  const rows = running.slice(0, limit).map((p) => {
    // The "(x2)" repeat counter is for /logs; at the bottom of the screen it
    // only flickers (owner, 2026-10-01).
    const last = String((p.output || [])[p.output.length - 1] || "").replace(/\s*\(x\d+\)$/, "");
    return `  [bg ${p.id}] ${p.command || p.cmd}${last ? `  | ${String(last).replace(/\s+/g, " ")}` : ""}`;
  });
  if (running.length > limit) {
    rows[rows.length - 1] = `  ... ${running.length - limit + 1} more running, /ps to list`;
  }
  return rows;
}

/** 950, 22k, 1M, 1.5M: a token count as short as it can be read. */
export function compactCount(n) {
  if (n < 1000) return String(n);
  if (n < 1e6) return `${Math.round(n / 1000)}k`;
  return `${(n / 1e6).toFixed(1).replace(/.0$/, "")}M`;
}

// Unread messages shown above the input, newest last, at most this many.
export const QUEUE_ROWS = 3;

/** Rows for the messages typed while the agent works and not yet read. */
export function queueRows(queued, limit = QUEUE_ROWS) {
  const list = queued || [];
  if (!list.length) return [];
  const first = (t) => String(t || "").split("\n").map((l) => l.trim()).find(Boolean) || "";
  const shown = list.slice(-limit).map((q) => `  queued  ${first(q.display)}`);
  if (list.length > limit) shown.unshift(`  queued  … ${list.length - limit} earlier, not read yet`);
  // Esc takes the newest one back into the input (App.js).
  shown[shown.length - 1] += "   · Esc to edit";
  return shown;
}

/** The single status row. */
export function statusText(state) {
  const parts = [];
  if (state.model) parts.push(state.model);
  if (state.sessionCost != null) parts.push(`${state.sessionCostEstimated ? "~" : ""}$${state.sessionCost.toFixed(4)}`);
  if (state.contextTokens && state.contextLimit) {
    // Size, not a percentage: "ctx 1%" of a 1M window hid 10k of context
    // (owner, 2026-10-01).
    // "~" while it is an estimate (a session just loaded, no reply yet).
    parts.push(`ctx ${state.contextEstimated ? "~" : ""}${compactCount(state.contextTokens)}/${compactCount(state.contextLimit)}`);
  }
  // What changes during work first; the care level and /help last, where the
  // footer's right edge may cut them on a narrow window.
  const bg = (state.processes || []).filter((p) => p.status === "running").length;
  if (bg) parts.push(`${bg} bg`);
  if (state.queued > 0) parts.push(`${state.queued} queued`);
  if (state.autoMode) {
    const a = state.autoMode;
    parts.push(`AUTO ${a.tasksDone}/${a.tasksTotal}`);
  }
  parts.push(formatStatusLevel());
  if (state.spendLevel) parts.push(`spend: ${state.spendLevel}`);
  if (state.freeLimit != null) parts.push(`free ${state.freeUsed}/${state.freeLimit}`);
  parts.push("/help");
  return ` ${parts.join("  |  ")}`;
}

/**
 * The live zone's rows, fitted to a budget (owner, 2026-10-01: every part was
 * bounded, but all of them together could still reach the window's height,
 * and then Ink clears and reprints the whole session on every render).
 *
 * Parts in order of importance: an approval or pairing, the running tool,
 * unread messages, background processes, the paste preview. Each gets what
 * is left of the budget; one that does not fit whole is folded into a
 * one-line count (or dropped, for the paste preview). The approval is never
 * folded: confirmRows already points to the history when its command does
 * not fit.
 *
 * @returns {Array<{key: string, text: string, props: object}>}
 */
export function layoutLiveZone(state, { pasteRows = [], budget = Infinity, now = Date.now(), columns } = {}) {
  const out = [];
  let left = Math.max(0, budget);
  const take = (key, rows, props, fold) => {
    if (!rows.length || left <= 0) return;
    if (rows.length <= left) {
      rows.forEach((text, i) => out.push({ key: `${key}-${i}`, text, props: typeof props === "function" ? props(i) : props }));
      left -= rows.length;
      return;
    }
    if (fold) {
      out.push({ key: `${key}-fold`, text: fold(rows), props: typeof props === "function" ? props(0) : props });
      left -= 1;
    }
  };
  take("confirm", confirmRows(state, now, columns), (i) => ({ color: i === 0 ? "yellowBright" : "white" }));
  const tool = liveToolText(state);
  take("tool", tool ? [tool] : [], { dimColor: true });
  const queued = state.queuedInputs || [];
  take("queue", queueRows(queued), { color: "gray" },
    () => `  queued  ${queued.length} message${queued.length === 1 ? "" : "s"}, not read yet   · Esc to edit`);
  const running = (state.processes || []).filter((p) => p.status === "running").length;
  take("dock", dockRows(state.processes), { dimColor: true },
    () => `  ${running} background process${running === 1 ? "" : "es"} running, /ps to list`);
  take("paste", pasteRows.map((r) => `  ${r}`), { dimColor: true });
  return out;
}

/** Rows the zone above the separator takes, for the layout cap and its test. */
export function liveZoneRows(state, now = Date.now(), opts = {}) {
  return layoutLiveZone(state, { ...opts, now }).length;
}

const row = (text, props = {}) => h(Box, null, h(Text, { wrap: "truncate-end", ...props }, text));

export function LiveZoneTop({ state, pasteRows = [], budget = Infinity }) {
  const rows = layoutLiveZone(state, { pasteRows, budget });
  return h(Box, { flexDirection: "column" },
    ...rows.map((r) => h(Box, { key: r.key }, h(Text, { wrap: "truncate-end", ...r.props }, r.text))),
  );
}

/**
 * The footer: the fixed-width activity block, then the session facts. The
 * block is the same width idle or busy, so nothing after it moves.
 */
export function StatusLine({ state }) {
  return h(Box, null, h(Text, { wrap: "truncate-end" },
    h(Text, { color: state.agentStatus && state.agentStatus !== "idle" ? "white" : "gray" }, ` ${activityText(state)}`),
    h(Text, { dimColor: true }, `│${statusText(state)}`),
  ));
}
