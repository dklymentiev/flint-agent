// Retrieval memory — Layer 4 of memory architecture.
//
// Unlike Layers 1-3 (frozen at session start in system prompt), Layer 4
// injects PER-TURN context: on each user message, look up the most
// similar past requests and surface "similar past requests used tool X"
// as a just-in-time hint.
//
// Backing store: patterns.jsonl (already populated by Layer 2).
// Similarity: Jaccard token overlap (no embeddings, no extra deps).

import { loadAll as loadAllPatterns } from "./patterns.js";
import { tokenize } from "./patterns.js";

function jaccard(aSet, bSet) {
  let inter = 0;
  for (const x of aSet) if (bSet.has(x)) inter++;
  const union = aSet.size + bSet.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Find the top-K most-similar past requests to the given request.
 * @param {string} request
 * @param {object} opts
 * @param {number} opts.topK — how many matches to return (default 5)
 * @param {number} opts.minSimilarity — Jaccard threshold (default 0.25)
 * @returns {Array<{record:object, similarity:number}>}
 */
export function findSimilarRequests(request, opts = {}) {
  const topK = opts.topK || 5;
  const minSim = opts.minSimilarity ?? 0.25;
  if (!request || typeof request !== "string") return [];
  const queryTokens = new Set(tokenize(request));
  if (queryTokens.size === 0) return [];

  const records = loadAllPatterns();
  const scored = [];
  for (const r of records) {
    if (!r.tokens || !Array.isArray(r.tokens)) continue;
    const s = jaccard(queryTokens, new Set(r.tokens));
    if (s < minSim) continue;
    scored.push({ record: r, similarity: s });
  }
  scored.sort((a, b) => b.similarity - a.similarity);
  return scored.slice(0, topK);
}

/**
 * Aggregate matches into "N past requests similar to this one used tool X
 * in M of N cases". Returns an injectable hint string or empty.
 *
 * @param {Array<{record,similarity}>} matches
 * @returns {string}
 */
export function formatRetrievalHint(matches) {
  if (!matches?.length) return "";

  // Count first_tool occurrences
  const toolCounts = new Map();
  for (const m of matches) {
    const t = m.record.first_tool;
    if (!t) continue;
    toolCounts.set(t, (toolCounts.get(t) || 0) + 1);
  }
  if (toolCounts.size === 0) return "";

  const sorted = [...toolCounts.entries()].sort((a, b) => b[1] - a[1]);
  const top = sorted[0];
  const total = matches.length;
  const [topTool, topCount] = top;

  // Only emit a hint if the dominant tool is majority (>= 50%) and we
  // have at least 2 supporting cases. Otherwise, ambiguous history.
  if (topCount < 2 || topCount / total < 0.5) return "";

  const topSimilarity = Math.round(matches[0].similarity * 100);
  const parts = [`Similar past requests (top match ${topSimilarity}% token overlap): ${topCount}/${total} used ${topTool}.`];
  if (sorted.length > 1) {
    const others = sorted.slice(1).map(([t, c]) => `${t}(${c})`).join(", ");
    parts.push(`Others: ${others}.`);
  }
  parts.push(`Prefer ${topTool} unless the current request differs materially.`);
  return parts.join(" ");
}
