// Spend modes: economy, normal, generous. One switch for how many tokens go
// into each model call (docs/spend-modes.md).
//
// Every saving rule had its own variable and a default tuned for cheap,
// small-window runs, so a first try with a capable model met an agent that
// summarised what it had read and searched for tools it had been given.
// A mode sets them together, the way the care level sets which tools ask.
// A variable for a single setting still wins over the mode.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const SPEND_NAMES = ["economy", "normal", "generous"];
export const DEFAULT_SPEND = "normal";

/**
 * The table of docs/spend-modes.md, as data. Fractions are of the model's
 * context window; `cap` is a ceiling in tokens (null: none); `unknown` is
 * used when the window is not known.
 */
export const SPEND_LEVELS = {
  economy: {
    description: "fewest tokens a call: tools through search, early compression and swap, saving advice for the model",
    mcpInlineMax: 10,
    compress: { fraction: 0.25, cap: 64000, unknown: 32000 },
    swapFromShare: 0.5,
    swap: { resultMax: 2048, budgetTokens: 8000, headBytes: 1024 },
    conv: { fraction: 0.4, cap: 150000, unknown: 60000 },
    advice: true,
  },
  normal: {
    description: "balanced: up to 30 MCP tools whole, compression at half the window, swap just before it",
    mcpInlineMax: 30,
    compress: { fraction: 0.5, cap: 128000, unknown: 64000 },
    swapFromShare: 0.75,
    swap: { resultMax: 4096, budgetTokens: 16000, headBytes: 1500 },
    conv: { fraction: 0.6, cap: 300000, unknown: 100000 },
    advice: false,
  },
  generous: {
    description: "most context: every tool whole, compression and swap only near the window's edge",
    mcpInlineMax: 200,
    compress: { fraction: 0.8, cap: null, unknown: 200000 },
    swapFromShare: 0.9,
    swap: { resultMax: 16384, budgetTokens: 64000, headBytes: 4096 },
    conv: { fraction: 0.85, cap: null, unknown: 200000 },
    advice: false,
  },
};

function spendFile() {
  const dir = process.env.FLINT_DATA_DIR ? path.resolve(process.env.FLINT_DATA_DIR) : path.join(homedir(), ".flint");
  return path.join(dir, "spend.json");
}

/** A level name from loose input ("e", "Economy", "gen"), or null. */
export function parseSpendName(input) {
  const s = String(input || "").trim().toLowerCase();
  if (!s) return null;
  return SPEND_NAMES.find((n) => n === s || n.startsWith(s)) || null;
}

/** FLINT_SPEND, else the saved choice, else normal. An unknown name reads as normal. */
export function getSpendLevel(env = process.env) {
  const fromEnv = parseSpendName(env.FLINT_SPEND);
  if (fromEnv) return fromEnv;
  try {
    const f = spendFile();
    if (existsSync(f)) {
      const saved = parseSpendName(JSON.parse(readFileSync(f, "utf8")).level);
      if (saved) return saved;
    }
  } catch {}
  return DEFAULT_SPEND;
}

/** Save a level; returns the level, or null for a name that is not one. */
export function setSpendLevel(name) {
  const level = parseSpendName(name);
  if (!level) return null;
  const f = spendFile();
  mkdirSync(path.dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify({ level }, null, 2) + "\n", "utf8");
  return level;
}

export function spendSettings(level = getSpendLevel()) {
  return SPEND_LEVELS[level] || SPEND_LEVELS[DEFAULT_SPEND];
}

/** A window share with a ceiling, or the fallback when the window is unknown. */
export function windowShare({ fraction, cap, unknown }, window) {
  if (!window) return unknown;
  const v = Math.floor(window * fraction);
  return cap ? Math.min(v, cap) : v;
}
