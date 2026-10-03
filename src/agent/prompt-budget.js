// Prompt Budget Allocator — waterfall allocation with min/max per section.
//
// Each section declares priority, min tokens, max tokens.
// Allocator gives min to all sections first, then distributes remaining
// budget up to max in priority order. Conversation history gets the remainder.
//
// Token estimation: chars / 4 (rough but fast, no tiktoken dependency).

import { config } from "../config.js";

const DEFAULT_MAX_PROMPT_TOKENS = 100_000;
const CHARS_PER_TOKEN = 4; // rough approximation

/**
 * Estimate token count from string content.
 */
export function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Create a budget allocator instance.
 * @param {number} [maxTokens] - Total prompt budget in tokens
 */
export function createBudgetAllocator(maxTokens) {
  const budget = maxTokens || config.maxPromptTokens || DEFAULT_MAX_PROMPT_TOKENS;
  const sections = [];

  return {
    /**
     * Add a named section with content and budget constraints.
     * @param {string} name - Section identifier
     * @param {string} content - Section text content
     * @param {object} opts
     * @param {number} opts.priority - Lower = higher priority (1 = must-have, 10 = nice-to-have)
     * @param {number} [opts.min] - Minimum tokens (guaranteed if content available)
     * @param {number} [opts.max] - Maximum tokens (cap even if budget allows more)
     * @param {boolean} [opts.fixed] - If true, include as-is without truncation
     */
    addSection(name, content, { priority, min = 0, max = Infinity, fixed = false } = {}) {
      if (!content) return;
      const tokens = estimateTokens(content);
      sections.push({ name, content, tokens, priority, min, max, fixed });
    },

    /**
     * Build the final prompt string respecting the budget.
     * Returns { prompt, stats } where stats shows per-section token usage.
     */
    build() {
      if (!sections.length) return { prompt: "", stats: {} };

      // Sort by priority (lower = higher priority)
      const sorted = [...sections].sort((a, b) => a.priority - b.priority);

      // Phase 1: give minimum to all sections
      let used = 0;
      const allocations = new Map();

      for (const s of sorted) {
        if (s.fixed) {
          allocations.set(s.name, s.tokens);
          used += s.tokens;
        } else {
          const minAlloc = Math.min(s.min, s.tokens); // don't allocate more than content
          allocations.set(s.name, minAlloc);
          used += minAlloc;
        }
      }

      // Phase 2: distribute remaining budget up to max, in priority order
      let remaining = budget - used;
      for (const s of sorted) {
        if (s.fixed || remaining <= 0) continue;
        const current = allocations.get(s.name);
        const want = Math.min(s.tokens, s.max) - current;
        if (want <= 0) continue;
        const give = Math.min(want, remaining);
        allocations.set(s.name, current + give);
        remaining -= give;
      }

      // Phase 3: build output, truncating sections to their allocation
      const parts = [];
      const stats = {};

      // Maintain original insertion order
      for (const s of sections) {
        const allocated = allocations.get(s.name) || 0;
        stats[s.name] = { tokens: s.tokens, allocated, truncated: false };

        if (s.fixed || s.tokens <= allocated) {
          parts.push(s.content);
        } else {
          // Truncate: keep head (70%) + tail (20%) + marker
          const maxChars = allocated * CHARS_PER_TOKEN;
          if (maxChars <= 0) continue;
          const headChars = Math.floor(maxChars * 0.7);
          const tailChars = Math.floor(maxChars * 0.2);
          const head = s.content.slice(0, headChars);
          const tail = s.content.slice(-tailChars);
          parts.push(`${head}\n\n[...truncated ${s.name}: ${s.tokens} tokens -> ${allocated} tokens...]\n\n${tail}`);
          stats[s.name].truncated = true;
        }
      }

      return {
        prompt: parts.join("\n\n"),
        stats,
        budget,
        used: [...allocations.values()].reduce((a, b) => a + b, 0),
        remaining: budget - [...allocations.values()].reduce((a, b) => a + b, 0),
      };
    },
  };
}
