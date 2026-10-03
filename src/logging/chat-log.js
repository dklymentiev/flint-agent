import { appendFileSync } from "node:fs";
import path from "node:path";
import { config } from "../config.js";

const ANSI_RE = /\x1b\[[0-9;]*m/g;
function stripAnsi(s) { return s.replace(ANSI_RE, ""); }

export function logChatLine(sessionId, text) {
  if (!sessionId) return;
  const file = path.join(config.sessionsDir, `${sessionId}.chat.log`);
  const ts = new Date().toISOString().slice(11, 19);
  try {
    appendFileSync(file, `[${ts}] ${stripAnsi(text)}\n`);
  } catch {}
}
