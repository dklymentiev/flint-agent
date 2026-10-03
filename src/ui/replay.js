// The end of a session as it was on screen, shown again when the session is
// continued (/resume, /load, a restart, --session, --last).
//
// Owner, 2026-10-02: after a resume the screen was empty, and the only way to
// see where the conversation had got to was to ask the agent. The session's
// chat log has every line exactly as it was shown (answers, ledger lines,
// receipts), so its last lines are put back. They are for the eyes only: the
// model's context is the session's saved messages, which a resume restores
// whether or not anything is shown.

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import chalk from "chalk";
import { config } from "../config.js";

/** How many lines of a continued session are shown again. */
export const RESUME_TAIL_LINES = 80;

const STAMP_RE = /^\[\d\d:\d\d:\d\d\] ?/;

// Lines about the session rather than in it: leaving and loading it, and the
// start banner a restart prints into the same log. Owner, 2026-10-02: the
// first resume showed "> exit", "Session saved", "Bye!" and "Loaded
// session" in the middle of the conversation.
const HOUSEKEEPING_RE = [
  /^\s*> (exit|quit)\s*$/,
  /^\s*> \/\S*(\s.*)?$/,               // slash commands
  /^Session saved: /,
  /^Bye!\s*$/,
  /^\s*Loaded session \S+ \(/,
  /^\s*\\ \/\s*$/,                     // banner up to 1.13 (the mascot)
  /FLINT AGENT v\d/,
  /^\s*▀▀▀ █   ▀ █▄ █ ▀█▀\s*$/,          // banner since 1.14: the FLiNT mark
  /^\s*█▀▀ █▄▄ █ █ ▀█  █\s+v\d/,
  /^ (model|session|api|token|mcp):\s/,
  /^ type \/help for commands/,
  /^\s*mcp: \S+ (connected \(|-- )/,
  /^\s*Restarting agent/,
];

/** A line the operator typed, as the chat log has it ("> text", "api@host > text"). */
const USER_LINE_RE = /^\s*(\S+@\S+ )?> \S/;

/**
 * The conversation part of a chat log's lines: housekeeping dropped, runs of
 * blank lines collapsed to one.
 */
export function conversationLines(lines) {
  const out = [];
  for (const line of lines) {
    if (HOUSEKEEPING_RE.some((re) => re.test(line))) continue;
    if (!line.trim() && (!out.length || !out[out.length - 1].trim())) continue;
    out.push(line);
  }
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return out;
}

/**
 * The last `n` lines of a session's chat log, without their time stamps or
 * housekeeping, starting at a message the operator typed so the tail does not
 * open in the middle of an answer. Empty when there is no log.
 */
export function chatLogTail(sessionId, n = RESUME_TAIL_LINES, dir = config.sessionsDir) {
  if (!sessionId || !dir) return [];
  const file = path.join(dir, `${sessionId}.chat.log`);
  if (!existsSync(file)) return [];
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const lines = conversationLines(text.split(/\r?\n/).map((l) => l.replace(STAMP_RE, "")));
  const tail = lines.slice(-n);
  // Open at the first message typed within the tail; a tail without one (a
  // single long answer) is kept as it is.
  const first = tail.findIndex((l) => USER_LINE_RE.test(l));
  return first > 0 ? tail.slice(first) : tail;
}

/**
 * Show the end of a continued session in the history, between two dim rules.
 * Returns how many lines were shown.
 */
export function replaySessionTail(store, sessionId, n = RESUME_TAIL_LINES, dir = config.sessionsDir) {
  const tail = chatLogTail(sessionId, n, dir);
  if (!tail.length) return 0;
  const add = (t) => store.getState().addLine(t, { replay: true });
  add(chalk.dim(`  ── the end of session ${sessionId}, as it was (last ${tail.length} lines) ──`));
  for (const line of tail) add(line);
  add(chalk.dim("  ── resumed here ──"));
  return tail.length;
}
