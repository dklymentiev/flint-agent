// Patterns memory — Layer 2 of memory architecture.
//
// Records per-turn: what user request (tokenized) → which tool the agent
// chose first. Compiles into a tool-preference table injected at session
// start. Purpose: triplet-consistency — three paraphrases of the same
// request should converge on the same tool.

import {
  insertPattern, getAllPatterns, migrateFromJsonl,
  findSimilarPattern, incrementPatternSuccess, replacePatternTool, getTopPatterns,
} from "./sqlite-store.js";

// Run migration on first import (idempotent)
try { migrateFromJsonl(); } catch {}

const STOP_WORDS = new Set([
  // English
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "should", "could",
  "can", "may", "might", "i", "you", "he", "she", "it", "we", "they",
  "my", "your", "his", "her", "its", "our", "their", "this", "that", "these", "those",
  "to", "of", "in", "on", "at", "for", "with", "by", "from", "as", "and", "or", "but",
  "not", "no", "if", "so", "then", "than", "when", "where", "what", "why", "how",
  "please", "me", "some",
]);

/**
 * Tokenize a request into lowercased, stop-word-filtered tokens.
 * Keeps letters and digits of any script, 3+ chars only.
 */
export function tokenize(text) {
  if (!text || typeof text !== "string") return [];
  // Split on anything that is not a letter or digit, in any script
  const raw = text.toLowerCase().split(/[^\p{L}\p{N}_]+/u);
  const out = [];
  const seen = new Set();
  for (const t of raw) {
    if (!t || t.length < 3) continue;
    if (STOP_WORDS.has(t)) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/**
 * Record a pattern with versioning support.
 * - If similar tokens + same tool exists: increment success_count (reinforcement)
 * - If similar tokens + different tool: replace tool (correction/versioning)
 * - Otherwise: insert new pattern
 * @param {{ request:string, first_tool:string, all_tools?:string[], ok?:boolean, session_id?:string }} p
 * @returns {string|null} id or null if skipped
 */
export function recordPattern(p) {
  if (!p || !p.request || !p.first_tool) return null;
  const tokens = tokenize(p.request);
  if (tokens.length === 0) return null;

  // Check for existing similar pattern (Jaccard >= 0.5 on tokens)
  const existing = findSimilarPattern(tokens, p.first_tool);
  if (existing) {
    // Same tool: reinforce
    incrementPatternSuccess(existing.id);
    return existing.id;
  }

  // Check if there's a pattern with same tokens but DIFFERENT tool (correction)
  const allPatterns = getAllPatterns();
  for (const ep of allPatterns) {
    if (ep.first_tool === p.first_tool) continue;
    const intersection = tokens.filter(t => (ep.tokens || []).includes(t)).length;
    const union = new Set([...tokens, ...(ep.tokens || [])]).size;
    if (union > 0 && intersection / union >= 0.5) {
      // Correction: replace tool, increment version + fail_count
      replacePatternTool(ep.id, p.first_tool, Array.isArray(p.all_tools) ? p.all_tools.slice(0, 20) : [p.first_tool]);
      return ep.id;
    }
  }

  // New pattern
  const now = new Date();
  const record = {
    // Random tail for the same reason as facts.js: one millisecond, one id.
    id: `p-${now.getTime().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    ts: now.toISOString(),
    session_id: p.session_id || "",
    request: String(p.request).slice(0, 500),
    tokens,
    first_tool: p.first_tool,
    all_tools: Array.isArray(p.all_tools) ? p.all_tools.slice(0, 20) : [p.first_tool],
    ok: p.ok !== false,
    success_count: 1,
    fail_count: 0,
    version: 1,
  };
  insertPattern(record);
  return record.id;
}

export function loadAll() {
  return getAllPatterns();
}

/**
 * For each tool, find the tokens most predictive of that tool choice.
 * Returns a map: tool_name → [tokens sorted by descriminating power].
 *
 * Method: for each (tool, token) pair, compute conditional probability
 *   P(tool | token) = count(tool ∧ token) / count(token)
 * Only tokens seen ≥ MIN_TOKEN_USES times are kept. Only pairs with
 * P ≥ MIN_CONFIDENCE are kept.
 */
export function compilePreferences(opts = {}) {
  const MIN_TOKEN_USES = opts.minTokenUses || 3;
  const MIN_CONFIDENCE = opts.minConfidence || 0.6;
  const MAX_TOKENS_PER_TOOL = opts.maxTokensPerTool || 6;
  const records = loadAll();
  // Check total weight (success_count sum), not just record count
  const totalWeight = records.reduce((s, r) => s + (r.success_count ?? 1), 0);
  if (totalWeight < MIN_TOKEN_USES) return {};

  // Count per token: total + per-tool (weighted by success_count)
  const tokenTotal = new Map();
  const tokenByTool = new Map(); // token → Map(tool → count)
  for (const r of records) {
    if (!r.ok) continue;
    // Filter out patterns with poor success rate
    const sr = (r.success_count ?? 1) / Math.max((r.success_count ?? 1) + (r.fail_count ?? 0), 1);
    if (sr < 0.4) continue; // skip patterns that fail more than 60% of the time
    const weight = r.success_count ?? 1; // use success_count as weight
    for (const tok of r.tokens || []) {
      tokenTotal.set(tok, (tokenTotal.get(tok) || 0) + weight);
      if (!tokenByTool.has(tok)) tokenByTool.set(tok, new Map());
      const tm = tokenByTool.get(tok);
      tm.set(r.first_tool, (tm.get(r.first_tool) || 0) + weight);
    }
  }

  // For each tool, collect tokens where P(tool | token) >= threshold
  const prefs = {}; // tool → [{token, confidence, support}]
  for (const [token, total] of tokenTotal) {
    if (total < MIN_TOKEN_USES) continue;
    const tm = tokenByTool.get(token);
    for (const [tool, count] of tm) {
      const confidence = count / total;
      if (confidence < MIN_CONFIDENCE) continue;
      if (!prefs[tool]) prefs[tool] = [];
      prefs[tool].push({ token, confidence, support: count });
    }
  }

  // Sort and cap per tool
  for (const tool of Object.keys(prefs)) {
    prefs[tool].sort((a, b) => {
      // Primary: confidence desc; secondary: support desc
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      return b.support - a.support;
    });
    prefs[tool] = prefs[tool].slice(0, MAX_TOKENS_PER_TOOL);
  }

  return prefs;
}

/**
 * Format compiled preferences as a compact prompt-ready block.
 * @param {Record<string, Array<{token,confidence,support}>>} prefs
 * @returns {string}
 */
export function formatForPrompt(prefs) {
  const tools = Object.keys(prefs);
  if (!tools.length) return "";
  const lines = ["Tool preferences learned from past successful sessions:"];
  for (const tool of tools) {
    const items = prefs[tool];
    if (!items?.length) continue;
    const tokens = items.map(i => `${i.token} (${Math.round(i.confidence * 100)}%, n=${i.support})`).join(", ");
    lines.push(`  ${tool}: ${tokens}`);
  }
  lines.push("Prefer these tools when the user's request contains the listed keywords.");
  return lines.join("\n");
}

export const __internal = { STOP_WORDS };
