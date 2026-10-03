import { appendFileSync } from "node:fs";
import { config } from "../config.js";
import path from "node:path";

export function logToolResult(sessionId, { toolCallId, name, args, result }) {
  if (!sessionId) return;
  const file = path.join(config.sessionsDir, `${sessionId}.tools.log`);
  const ts = new Date().toISOString().slice(11, 19);
  const argsStr = Object.entries(args)
    .map(([k, v]) => {
      const s = typeof v === "string" && v.length > 100 ? v.slice(0, 100) + "..." : String(v);
      return `${k}=${s}`;
    })
    .join(" ");
  const header = `[${ts}] ${name}(${argsStr})`;
  const sep = "-".repeat(60);
  try {
    appendFileSync(file, `${sep}\n${header}\n${sep}\n${result}\n\n`);
  } catch {}
}
