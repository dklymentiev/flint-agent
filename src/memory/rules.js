// Rules memory — Layer 3 of memory architecture.
//
// Aggregates `better` bullets from ALL reflections (Layer 1) into a
// stable ruleset: groups semantically-similar lessons, counts frequency,
// surfaces top-N canonical rules.
//
// Purpose: Layer 1 injects last-5 reflections — random recent slice.
// Layer 3 injects the most-repeated lessons across the full history —
// load-bearing advice that shows up session after session. Answers the
// question "what has the agent learned most often to do differently?"

import { loadAll as loadAllReflections } from "./reflections.js";
import { tokenize } from "./patterns.js";

function jaccard(setA, setB) {
  let inter = 0;
  for (const x of setA) if (setB.has(x)) inter++;
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Cluster bullets by Jaccard token similarity (greedy agglomerative).
 * Two bullets merge if overlap ≥ threshold with any cluster member.
 */
function clusterByJaccard(bullets, threshold = 0.4) {
  const items = bullets.map(b => ({ text: b.text, tags: b.tags, tokens: new Set(tokenize(b.text)) }));
  const clusters = [];
  for (const item of items) {
    if (item.tokens.size === 0) continue;
    let matched = null;
    for (const c of clusters) {
      for (const m of c.members) {
        if (jaccard(item.tokens, m.tokens) >= threshold) {
          matched = c;
          break;
        }
      }
      if (matched) break;
    }
    if (matched) {
      matched.members.push(item);
      for (const t of item.tags) matched.tags.add(t);
    } else {
      clusters.push({ members: [item], tags: new Set(item.tags) });
    }
  }
  return clusters;
}

/**
 * Compile top-N stable rules from all reflections.
 * @param {object} opts
 * @param {number} opts.topN — max rules to return (default 8)
 * @param {number} opts.minCount — min occurrences to keep a cluster (default 2)
 * @param {number} opts.similarity — Jaccard threshold for clustering (default 0.4)
 * @returns {Array<{text:string, count:number, tags:string[]}>}
 */
export function compileRules(opts = {}) {
  const topN = opts.topN || 8;
  const minCount = opts.minCount || 2;
  const similarity = opts.similarity || 0.4;

  const reflections = loadAllReflections();
  if (!reflections.length) return [];

  const bullets = [];
  for (const r of reflections) {
    const tags = Array.isArray(r.tags) ? r.tags : [];
    for (const b of (r.better || [])) {
      if (typeof b !== "string" || b.length < 15) continue;
      bullets.push({ text: b, tags });
    }
  }
  if (!bullets.length) return [];

  const clusters = clusterByJaccard(bullets, similarity);

  const result = [];
  for (const c of clusters) {
    if (c.members.length < minCount) continue;
    // Canonical = shortest member ≥ 30 chars, fallback to first
    let canonical = c.members[0].text;
    for (const m of c.members) {
      if (m.text.length >= 30 && m.text.length < canonical.length) canonical = m.text;
    }
    result.push({ text: canonical, count: c.members.length, tags: [...c.tags].slice(0, 3) });
  }
  result.sort((a, b) => b.count - a.count);
  return result.slice(0, topN);
}

/**
 * Format rules as a prompt block.
 * @param {Array<{text,count,tags}>} rules
 */
export function formatForPrompt(rules) {
  if (!rules?.length) return "";
  const lines = ["Stable rules distilled from past sessions (most-repeated lessons):"];
  for (const r of rules) {
    const tags = r.tags?.length ? ` [${r.tags.slice(0, 3).join(",")}]` : "";
    lines.push(`  - (${r.count}×)${tags} ${r.text}`);
  }
  return lines.join("\n");
}
