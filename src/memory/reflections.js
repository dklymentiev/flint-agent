// Reflections memory — auto-extracted learnings at session end.
//
// Layer 1 of memory architecture.
// Backend: SQLite via sqlite-store.js (migrated from JSONL 2026-04-16).
// At session end, model is prompted with 3 questions (did / wrong / better),
// response is parsed and stored. At next session start, last N are prepended
// to system prompt as trusted-context so model doesn't repeat past mistakes.

import { insertReflection, getRecentReflections, getAllReflections, migrateFromJsonl } from "./sqlite-store.js";

// Run migration on first import (idempotent — skips if already migrated)
try { migrateFromJsonl(); } catch {}

/**
 * Append a reflection.
 * @param {{ id?:string, ts?:string, session_id?:string, did:string, wrong:string[], better:string[], tags?:string[] }} reflection
 * @returns {string|null} id
 */
export function appendReflection(reflection) {
  const now = new Date();
  const record = {
    id: reflection.id || `r-${now.toISOString().slice(0, 10)}-${now.getTime().toString(36).slice(-5)}${Math.random().toString(36).slice(2, 5)}`,
    ts: reflection.ts || now.toISOString(),
    session_id: reflection.session_id || "",
    did: String(reflection.did || "").trim(),
    wrong: Array.isArray(reflection.wrong) ? reflection.wrong.filter(Boolean) : [],
    better: Array.isArray(reflection.better) ? reflection.better.filter(Boolean) : [],
    tags: Array.isArray(reflection.tags) ? reflection.tags.filter(Boolean) : [],
  };
  if (!record.did && record.wrong.length === 0 && record.better.length === 0) {
    return null;
  }
  return insertReflection(record);
}

/**
 * Load last N reflections (most recent first).
 */
export function loadRecent(n = 5) {
  return getRecentReflections(n);
}

/**
 * Load all reflections. Used by the pattern analyzer (Layer 2).
 */
export function loadAll() {
  return getAllReflections();
}

/**
 * Format reflections as a system-prompt-ready text block.
 * Short, scannable, focused on 'better' guidance.
 * @param {object[]} reflections
 * @returns {string}
 */
export function formatForPrompt(reflections) {
  if (!reflections.length) return "";
  const lines = ["Past lessons from recent sessions (avoid repeating these mistakes):"];
  for (const r of reflections) {
    const date = r.ts ? r.ts.slice(0, 10) : "";
    if (r.wrong.length) {
      lines.push(`\n[${date}] I did wrong:`);
      for (const w of r.wrong.slice(0, 3)) lines.push(`  - ${w}`);
    }
    if (r.better.length) {
      lines.push(`[${date}] Next time:`);
      for (const b of r.better.slice(0, 3)) lines.push(`  - ${b}`);
    }
  }
  return lines.join("\n");
}

// Exposed for tests (legacy references removed — now in sqlite-store)
export const __internal = {};
