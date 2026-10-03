// Facts memory — Layer 4 of memory architecture.
//
// User/project facts explicitly stated or extracted from conversation.
// "We use yarn not npm", "project runs on port 8080", "DB is PostgreSQL".
// Injected into system prompt so agent applies them without being reminded.
//
// Internal task reference removed.

import { insertFact, getAllFacts, deleteFact, indexEntry, searchFts, setFactPinned } from "./sqlite-store.js";

const MAX_FACTS = 100;

/**
 * Add a fact.
 * @param {string} content — the fact text
 * @param {string} category — general|project|preference|environment
 * @param {string} source — "user" or "agent"
 * @param {number} confidence — 0.0 to 1.0
 * @returns {string} fact id
 */
export function addFact(content, category = "general", source = "agent", confidence = 1.0, project = null) {
  if (!content || !content.trim()) return null;

  // Dedupe — don't add if very similar fact exists (any project)
  const existing = searchFts(content.slice(0, 50), { layer: "facts", limit: 3 });
  for (const e of existing) {
    if (e.text && textSimilarity(e.text, content) > 0.8) {
      return null; // too similar, skip
    }
  }

  // Eviction: never evict pinned facts. If cap reached and no unpinned
  // fact exists to evict, silently reject the new fact (prevents the cap
  // from being exceeded when all slots are curated).
  const all = getAllFacts();
  if (all.length >= MAX_FACTS) {
    // getAllFacts returns ORDER BY created_at DESC, so last element is oldest
    const oldestUnpinned = [...all].reverse().find(f => !f.pinned);
    if (!oldestUnpinned) return null; // all slots pinned — refuse new fact
    deleteFact(oldestUnpinned.id);
  }

  const now = new Date();
  // A random tail: two facts added in the same millisecond got the same id,
  // and the second overwrote the first without a word.
  const id = `fact-${now.getTime().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  insertFact({ id, category, content: content.trim(), source, confidence, project, pinned: 0 });
  indexEntry("facts", id, content.trim());
  return id;
}

/**
 * Remove a fact by id.
 */
export function removeFact(id) {
  deleteFact(id);
}

/**
 * Pin a fact — it will never be LRU-evicted. Use for durable knowledge
 * (user preferences, project metadata) that must survive heavy write
 * sessions (benchmarks, bulk agent work).
 */
export function pinFact(id) {
  setFactPinned(id, true);
}

/**
 * Unpin a fact — it becomes eligible for LRU eviction again.
 */
export function unpinFact(id) {
  setFactPinned(id, false);
}

/**
 * Get facts, optionally filtered by category and/or project scope.
 * @param {string|null} category — filter by category, null = all
 * @param {string|null|undefined} project — project scope:
 *   undefined/null = all facts (no scope filter)
 *   "" (empty string) = global only (project IS NULL)
 *   "name" = project "name" + global facts (union)
 */
export function getFacts(category = null, project = null) {
  const all = project === null ? getAllFacts() : getAllFacts({ project });
  if (category) return all.filter(f => f.category === category);
  return all;
}

/**
 * Format facts as system-prompt-ready block. Groups by category.
 * Uses the given project scope: global facts always included; project-scoped
 * only when currentProject matches. If currentProject is null, only globals.
 *
 * @param {number} maxTokens — approximate token budget
 * @param {string|null} currentProject — project name or null
 */
export function formatForPrompt(maxTokens = 500, currentProject = null) {
  const all = currentProject
    ? getAllFacts({ project: currentProject })  // scoped + global union
    : getAllFacts({ project: "" });              // global only
  if (!all.length) return "";

  const groups = {};
  for (const f of all) {
    const cat = f.category || "general";
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push(f);
  }

  const scopeLabel = currentProject ? `(scope: ${currentProject} + global)` : "(scope: global)";
  const lines = [`Known facts about user and project ${scopeLabel}:`];
  let tokens = 0;
  for (const [cat, facts] of Object.entries(groups)) {
    lines.push(`  [${cat}]`);
    for (const f of facts) {
      const marker = f.project ? `§[${f.project}]` : "§";
      const line = `    ${marker} ${f.content}`;
      tokens += line.split(/\s+/).length;
      if (tokens > maxTokens) break;
      lines.push(line);
    }
    if (tokens > maxTokens) break;
  }
  return lines.join("\n");
}

/**
 * Extract facts from a conversation turn.
 * Heuristic: look for patterns like "we use X", "our project is Y",
 * "I prefer Z", "the server runs on W".
 * @param {string} userMessage
 * @returns {Array<{content, category, confidence}>}
 */
/**
 * Extract facts from a user message. Uses the LLM-based extractor from
 * extract-facts.js (async, semantic). No regex, no hardcoded patterns —
 * the LLM decides what's a durable fact.
 *
 * Gated: only calls LLM for messages >= 20 chars that look like disclosures
 * (contain a pronoun-like signal). Short chit-chat ("ok", "yes", "done")
 * never triggers a call.
 *
 * @param {string} userMessage
 * @returns {Promise<Array<{content, category, confidence}>>}
 */
export async function extractFacts(userMessage) {
  if (!userMessage || userMessage.length < 20) return [];
  // Cheap language-neutral pre-filter — skip if message is clearly a question
  // or a bare command. Real disclosures are declarative statements.
  // Previously this used RU+EN keyword regex which was biased against
  // Ukrainian / German / Chinese users. Replaced 2026-04-19.
  const trimmed = userMessage.trim();
  // Skip pure questions (ends with ?)
  if (/\?\s*$/.test(trimmed)) return [];
  // Skip very short declarations (covered by length check above, but also
  // short imperative commands like "read X" or "open Y")
  const wordCount = trimmed.split(/\s+/).length;
  if (wordCount < 5) return [];

  try {
    const { extractFacts: extractViaLlm } = await import("./extract-facts.js");
    // extract-facts.js expects messages; wrap the single user message
    const out = await extractViaLlm([{ role: "user", content: userMessage }]);
    if (!Array.isArray(out)) return [];
    return out.map(f => ({ content: f.content, category: f.category || "general", confidence: 0.8 }));
  } catch {
    return [];
  }
}

// Simple word-overlap similarity
function textSimilarity(a, b) {
  const wa = new Set(a.toLowerCase().split(/\s+/));
  const wb = new Set(b.toLowerCase().split(/\s+/));
  let inter = 0;
  for (const w of wa) if (wb.has(w)) inter++;
  const union = wa.size + wb.size - inter;
  return union === 0 ? 0 : inter / union;
}

export const __internal = { MAX_FACTS };
