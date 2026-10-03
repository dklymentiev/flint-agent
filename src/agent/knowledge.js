/**
 * Knowledge Store — backend-agnostic facts & patterns
 *
 * Stores learned facts and patterns. Retrieves by keyword match.
 * Backend adapters: text file (default), mesh, agent-memory.
 *
 * Used by:
 *   - Layer 3 (Execution): retrieve before planning
 *   - Layer 4 (Verification Gate): store after successful task
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "../logging/logger.js";
import { config } from "../config.js";

const log = createLogger("knowledge");

// --- Storage path ---
const KNOWLEDGE_DIR = join(config.sessionsDir || process.cwd(), "..", "knowledge");
const FACTS_FILE = join(KNOWLEDGE_DIR, "facts.jsonl");

// --- In-memory cache ---
let _facts = [];
let _loaded = false;

/**
 * Load facts from disk (lazy, once).
 */
function _ensureLoaded() {
  if (_loaded) return;
  _loaded = true;
  try {
    if (existsSync(FACTS_FILE)) {
      const lines = readFileSync(FACTS_FILE, "utf-8").split("\n").filter(Boolean);
      _facts = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      log.info("loaded", { count: _facts.length });
    }
  } catch (e) {
    log.warn("load-failed", { error: e.message });
  }
}

/**
 * Store a fact or pattern.
 * @param {object} entry - { type: "fact"|"pattern", text, context, confidence, triggers }
 */
export function store(entry) {
  _ensureLoaded();
  entry.timestamp = new Date().toISOString();
  entry.confidence = entry.confidence || 0.5;
  _facts.push(entry);

  try {
    mkdirSync(KNOWLEDGE_DIR, { recursive: true });
    writeFileSync(FACTS_FILE, _facts.map(f => JSON.stringify(f)).join("\n") + "\n");
    log.info("stored", { type: entry.type, text: (entry.text || "").slice(0, 60) });
  } catch (e) {
    log.warn("store-failed", { error: e.message });
  }
}

/**
 * Retrieve relevant facts/patterns for a task.
 * @param {string} query - task description or keywords
 * @param {number} limit - max results
 * @returns {Array} matching entries, sorted by relevance
 */
export function retrieve(query, limit = 3) {
  _ensureLoaded();
  if (!_facts.length || !query) return [];

  const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  const scored = _facts.map(f => {
    const text = `${f.text || ""} ${(f.triggers || []).join(" ")} ${f.context || ""}`.toLowerCase();
    const matches = words.filter(w => text.includes(w)).length;
    return { ...f, score: matches * (f.confidence || 0.5) };
  }).filter(f => f.score > 0);

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

/**
 * Update confidence of a fact (called when pattern reused successfully).
 * @param {number} index - fact index
 * @param {number} delta - confidence change (+0.1 on success, -0.1 on failure)
 */
export function updateConfidence(index, delta) {
  _ensureLoaded();
  if (index >= 0 && index < _facts.length) {
    _facts[index].confidence = Math.max(0, Math.min(1, (_facts[index].confidence || 0.5) + delta));
    try {
      writeFileSync(FACTS_FILE, _facts.map(f => JSON.stringify(f)).join("\n") + "\n");
    } catch {}
  }
}

/**
 * Get all facts (for debugging/display).
 */
export function getAll() {
  _ensureLoaded();
  return [..._facts];
}

/**
 * Format retrieved knowledge for injection into prompt.
 */
export function formatForPrompt(entries) {
  if (!entries.length) return null;
  const lines = entries.map(e => `- [${e.type}] ${e.text}`);
  return `[KNOWLEDGE — learned from previous tasks]\n${lines.join("\n")}`;
}
