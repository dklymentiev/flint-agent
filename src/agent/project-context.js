// Project context (FLINT.md) — the agent's own notebook for the project
// it's currently working in. Walks up from CWD looking for FLINT.md,
// scans for prompt injection, returns content. Cached per-CWD for the
// life of the process (invalidated by file mtime change).
//
// Injected at the top of EVERY LLM prompt — classifier, agent loop,
// reflection, etc. — so the agent's own project rules are visible
// before any other context.

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";
import { detectInjection } from "../security/content-fence.js";

const MAX_CHARS = config.maxContextChars;
const _cache = new Map(); // path → { content, mtimeMs }

function findFile(startDir) {
  let dir = startDir;
  for (let i = 0; i < 10; i++) {
    const p = join(dir, "FLINT.md");
    if (existsSync(p)) return p;
    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function loadFlintMd(cwd = process.cwd()) {
  const p = findFile(cwd);
  if (!p) return null;

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

  // Injection scan — FLINT.md is user- or agent-written, but we still
  // scan because the agent itself could be fooled into writing malicious
  // instructions there via a crafted user message in a prior turn.
  const scan = detectInjection(content);
  if (scan.detected && scan.score >= 3) {
    const blocked = `[BLOCKED: FLINT.md at ${p} failed injection scan (score ${scan.score})]`;
    _cache.set(p, { content: blocked, mtimeMs });
    return blocked;
  }

  _cache.set(p, { content, mtimeMs });
  return content;
}

export function formatFlintMdBlock(cwd = process.cwd()) {
  const content = loadFlintMd(cwd);
  if (!content) return "";
  return [
    "<trusted-context name=\"project-rules\" source=\"FLINT.md\">",
    content,
    "</trusted-context>",
  ].join("\n");
}
