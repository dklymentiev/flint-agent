// The agent's own notes for the folder it works in: .flint/notes.md. The agent
// reads and writes the file itself (system.md says so); this puts it into the
// prompt. Scanned for prompt injection, because the agent could be talked into
// writing an instruction there in one turn and obey it in every later one.
// Cached per path for the life of the process (invalidated by mtime change).
//
// FLINT.md is not read here. It is the owner's instructions and goes with the
// host's instructions (stdio/session.js instructionsChain).

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";
import { detectInjection } from "../security/content-fence.js";

const MAX_CHARS = config.maxContextChars;
const NOTES = join(".flint", "notes.md");
const _cache = new Map(); // path → { content, mtimeMs }

export function loadNotes(cwd = process.cwd()) {
  const p = join(cwd, NOTES);
  let mtimeMs;
  try {
    mtimeMs = statSync(p).mtimeMs;
  } catch {
    return null;
  }

  const cached = _cache.get(p);
  if (cached && cached.mtimeMs === mtimeMs) return cached.content;

  let content;
  try {
    content = readFileSync(p, "utf-8");
  } catch {
    return null;
  }
  if (content.length > MAX_CHARS) {
    content = content.slice(0, MAX_CHARS) + "\n... (truncated)";
  }

  const scan = detectInjection(content);
  if (scan.detected && scan.score >= 3) {
    const blocked = `[BLOCKED: .flint/notes.md at ${p} failed injection scan (score ${scan.score})]`;
    _cache.set(p, { content: blocked, mtimeMs });
    return blocked;
  }

  _cache.set(p, { content, mtimeMs });
  return content;
}

export function formatNotesBlock(cwd = process.cwd()) {
  const content = loadNotes(cwd);
  if (!content) return "";
  return [
    "<untrusted-context name=\"notes\" source=\".flint/notes.md\">",
    content,
    "</untrusted-context>",
  ].join("\n");
}
