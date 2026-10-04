// Context swap: tool results past a budget move to the session's disk, with
// an index, and a one-line stub stays in their place. docs/context-swap.md.
//
// Everything a tool returns stayed in the conversation and was sent again on
// every call: a research turn of 23 calls sent 1,759k input tokens
// (2026-10-02). The half-window compression that existed cut results to
// one-liners and lost them; here what leaves the context is kept, with an
// address, and swap_list / swap_read bring it back.

import { getSpendLevel, spendSettings, windowShare } from "../spend.js";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Swap is on unless FLINT_SWAP=0. */
export function swapEnabled(env = process.env) {
  return env.FLINT_SWAP !== "0";
}

export function swapSettings(env = process.env, level = getSpendLevel(env)) {
  const int = (v, d) => (Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : d);
  const num = (v, d) => (Number.isFinite(parseFloat(v)) ? parseFloat(v) : d);
  const lv = spendSettings(level).swap;
  const budgetTokens = int(env.FLINT_SWAP_BUDGET, lv.budgetTokens);
  return {
    // New is whole, old is swapped. What the model has just asked for
    // reaches it in full, and room is made by evicting what it read before.
    // A result is cut on arrival only when it alone is bigger than everything
    // the results may take, so the limit is the budget in bytes and not a
    // number of its own. It was one: 4 KB at level normal, set for a run of
    // web pages, and it cut a 5 KB task file the operator had pointed at to
    // its first 1500 bytes; the agent said it had read the file and made up
    // the rest (2026-10-03).
    resultMax: int(env.FLINT_SWAP_RESULT_MAX, budgetTokens * 4),
    budgetTokens,
    lowWater: num(env.FLINT_SWAP_LOW_WATER, 0.6),
    minBytes: int(env.FLINT_SWAP_MIN_BYTES, 1024),
    headBytes: int(env.FLINT_SWAP_HEAD, lv.headBytes),
  };
}

// ── Describing a result ──────────────────────────────────────

/** page, file, command, search or other, from the tool's name. */
export function kindOf(tool) {
  const n = String(tool || "").toLowerCase();
  if (/run_command|run_background|peek_process|shell|exec/.test(n)) return "command";
  if (/search|glob|grep/.test(n)) return "search";
  if (/fetch|chrome|browser|page|navigate|url|web/.test(n)) return "page";
  if (/file|image/.test(n)) return "file";
  return "other";
}

/** The URL, path, command or query a call was about. */
export function sourceOf(tool, args = {}) {
  const a = args && typeof args === "object" ? args : {};
  const v = a.url ?? a.path ?? a.file_path ?? a.command ?? a.query ?? a.pattern ?? "";
  return String(v);
}

/**
 * The readable part of a result. Browser tools answer in JSON ({"url",
 * "title", "text": the page}): the live run put "{" as every title, no source,
 * and a head of escaped JSON. The page text, its URL and title are taken out;
 * anything else is the text as it is.
 */
export function readableOf(raw) {
  const s = String(raw ?? "");
  const t = s.trimStart();
  if (t.startsWith("{") && t.length < 20_000_000) {
    try {
      const o = JSON.parse(t);
      if (o && typeof o === "object" && !Array.isArray(o)) {
        const text = ["text", "content", "markdown", "body", "output", "result"].map((k) => o[k]).find((v) => typeof v === "string" && v.length);
        if (text) {
          const url = typeof o.url === "string" ? o.url : typeof o.href === "string" ? o.href : "";
          return { text, url, title: typeof o.title === "string" ? o.title : "" };
        }
      }
    } catch {}
  }
  return { text: s, url: "", title: "" };
}

const MD_HEADING = /^#{1,6}\s+\S/;
const HTML_HEADING = /<h([1-3])[^>]*>([\s\S]*?)<\/h\1>/i;

/** First heading, else the first non-empty line; at most 100 characters. */
export function titleOf(text) {
  const lines = String(text || "").split(/\r?\n/);
  for (const l of lines) {
    if (MD_HEADING.test(l)) return l.replace(/^#{1,6}\s+/, "").trim().slice(0, 100);
    const h = l.match(HTML_HEADING);
    if (h) return h[2].replace(/<[^>]+>/g, "").trim().slice(0, 100);
  }
  const first = lines.find((l) => l.trim());
  return (first || "").trim().slice(0, 100);
}

/** Up to `max` headings: markdown lines as they are, HTML h1-h3 as their text. */
export function outlineOf(text, max = 20) {
  const out = [];
  for (const l of String(text || "").split(/\r?\n/)) {
    if (out.length >= max) break;
    if (MD_HEADING.test(l)) { out.push(l.trim()); continue; }
    const h = l.match(HTML_HEADING);
    if (h) out.push(h[2].replace(/<[^>]+>/g, "").trim());
  }
  return out;
}

function size(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const oneLine = (s, max) => String(s || "").replace(/\s+/g, " ").trim().slice(0, max);

/**
 * The one-line stub that stands for an entry in the conversation. Built from
 * the entry alone, so the same entry always gives the same bytes (the prompt
 * cache depends on it).
 */
export function stubFor(e) {
  const source = oneLine(e.source, 160) || "-";
  // A conversation line carries a two-sentence summary; a page, a title.
  const title = oneLine(e.title, e.kind === "conversation" ? 240 : 100).replace(/"/g, "'");
  return `[swap #${e.id} · ${e.kind} · ${source} · ${size(e.bytes)} · "${title}" · turn ${e.turn} · swap_read ${e.id}]`;
}

/** What the model sees of a result swapped as it arrives: stub, head, outline. */
export function arrivalView(e, text, headBytes = 2048) {
  const s = String(text);
  const head = s.slice(0, headBytes);
  const parts = [stubFor(e), head];
  if (s.length > head.length) parts.push(`[... ${size(Buffer.byteLength(s.slice(head.length), "utf8"))} more: swap_read ${e.id} with offset/limit for a part]`);
  const outline = outlineOf(s, 30);
  if (outline.length) parts.push("Outline:\n" + outline.map((h) => `- ${h}`).join("\n"));
  return parts.join("\n");
}

// ── The store ────────────────────────────────────────────────

function slugOf(source, title) {
  const base = String(source || title || "item")
    .replace(/^[a-z]+:\/\//i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return base || "item";
}

const pad3 = (n) => String(n).padStart(3, "0");

function durationMs(since) {
  if (typeof since === "number") return since;
  const m = String(since || "").match(/^(\d+)\s*([smhd])$/);
  if (!m) return null;
  return Number(m[1]) * { s: 1e3, m: 6e4, h: 3.6e6, d: 8.64e7 }[m[2]];
}

/**
 * The swap of one session: files under `dir`, one index line per entry.
 * Nothing is written until the first put.
 */
export function createSwapStore(dir) {
  const indexFile = path.join(dir, "index.jsonl");
  const entries = [];
  if (existsSync(indexFile)) {
    for (const line of readFileSync(indexFile, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try { entries.push(JSON.parse(line)); } catch {}
    }
  }
  const byId = new Map(entries.map((e) => [e.id, e]));
  let nextId = entries.reduce((m, e) => Math.max(m, e.id), 0) + 1;

  return {
    dir,
    put({ turn = 0, call = 0, tool = "", kind, source = "", title, text = "" }) {
      const k = kind || kindOf(tool);
      const id = nextId++;
      const file = `t${pad3(turn)}/${pad3(id)}-${k}-${slugOf(source, title)}.${k === "page" ? "md" : "txt"}`;
      const e = {
        id, t: new Date().toISOString(), turn, call, tool, kind: k, source: String(source),
        title: title ?? titleOf(text), bytes: Buffer.byteLength(String(text), "utf8"), file,
      };
      mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      writeFileSync(path.join(dir, file), String(text), "utf8");
      appendFileSync(indexFile, JSON.stringify(e) + "\n", "utf8");
      entries.push(e);
      byId.set(id, e);
      return e;
    },
    get(id) {
      return byId.get(Number(id)) || null;
    },
    /** The entry's text, whole, or `limit` lines from line `offset` (1-based). */
    read(id, { offset, limit } = {}) {
      const e = byId.get(Number(id));
      if (!e) return null;
      let text;
      try { text = readFileSync(path.join(dir, e.file), "utf8"); } catch { return null; }
      if (!offset && !limit) return text;
      const lines = text.split("\n");
      const from = Math.max(1, Number(offset) || 1) - 1;
      const to = limit ? from + Number(limit) : lines.length;
      return lines.slice(from, to).join("\n");
    },
    /** Entries, newest first, filtered by turn, time, source and title words. */
    list({ turn, since, source, text, limit, now = Date.now() } = {}) {
      let out = [...entries].reverse();
      if (turn != null && turn !== "") out = out.filter((e) => e.turn === Number(turn));
      const ms = since != null ? durationMs(since) : null;
      if (ms != null) out = out.filter((e) => Date.parse(e.t) >= now - ms);
      if (source) out = out.filter((e) => String(e.source).toLowerCase().includes(String(source).toLowerCase()));
      if (text) {
        const words = String(text).toLowerCase().split(/\s+/).filter(Boolean);
        out = out.filter((e) => words.every((w) => String(e.title).toLowerCase().includes(w)));
      }
      if (limit) out = out.slice(0, Number(limit));
      return out;
    },
  };
}

// The store of the session the agent loop is running, for swap_list/swap_read.
let currentStore = null;
export function setCurrentSwapStore(store) { currentStore = store || null; }
export function getCurrentSwapStore() { return currentStore; }

// ── Eviction ─────────────────────────────────────────────────

const tokensOf = (content) => Math.ceil(String(content ?? "").length / 4);

const WRAP_RE = /^<([\w-]+) name="([^"]*)">\n([\s\S]*)\n<\/\1>$/;
function unwrap(content) {
  const m = String(content ?? "").match(WRAP_RE);
  return m ? { tool: m[2], text: m[3] } : { tool: "", text: String(content ?? "") };
}

/**
 * Indices of tool results to swap out, oldest first, or none. Only when the
 * tool results take more than `budgetTokens`, and then down to `lowWater` of
 * it, so the history is rewritten rarely and in batches (each rewrite costs
 * the prompt cache from that message on). Never swapped: anything but a tool
 * result, the results of the latest call (not read yet), results under
 * `minBytes`, results swapped already.
 *
 * The budget is for what can be evicted. Stubs and small results stay
 * whatever happens, so they are not counted: counted, the 475 stubs of a long
 * session took 14k of a 16k budget by themselves, the sum never came down to
 * the low-water mark, and every result was evicted one call after it arrived.
 */
export function planEviction(messages, { budgetTokens = 40000, lowWater = 0.6, minBytes = 1024 } = {}) {
  const evictable = (m) => m.role === "tool" && String(m.content ?? "").length >= minBytes;
  let total = 0;
  for (const m of messages) if (evictable(m)) total += tokensOf(m.content);
  if (total <= budgetTokens) return [];
  let lastCall = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant" && messages[i].tool_calls?.length) { lastCall = i; break; }
  }
  const target = budgetTokens * lowWater;
  const plan = [];
  for (let i = 0; i < messages.length && total > target; i++) {
    const m = messages[i];
    // A result swapped on arrival keeps its view (stub, head, outline) until
    // it is old enough to go; then it shrinks to the stub. Left out, thirty
    // views kept the live run at 46-50k tokens a call (2026-10-02). A bare
    // stub is under minBytes and stays.
    if (!evictable(m) || i > lastCall) continue;
    plan.push(i);
    total -= tokensOf(m.content);
  }
  return plan;
}

/** Arguments of the call a tool result answers, from the call itself. */
function callArgs(messages, i) {
  const m = messages[i];
  if (m._toolArgs) return m._toolArgs;
  for (let j = i - 1; j >= 0; j--) {
    const tc = messages[j].tool_calls?.find((c) => c.id === m.tool_call_id);
    if (tc) {
      try { return JSON.parse(tc.function?.arguments || "{}"); } catch { return {}; }
    }
  }
  return {};
}

/** Turn number (operator messages so far) and call number within the turn, at index i. */
export function turnAndCall(messages, i) {
  let turn = 0;
  let call = 0;
  for (let j = 0; j <= i && j < messages.length; j++) {
    if (messages[j].role === "user") { turn++; call = 0; } else if (messages[j].role === "tool") call++;
  }
  return { turn, call: Math.max(call, 1) };
}

/** Swap out what planEviction names; returns how many. */
export function applySwap(messages, store, opts = {}) {
  const plan = planEviction(messages, opts);
  for (const i of plan) {
    const m = messages[i];
    const { tool: wrappedTool, text: raw } = unwrap(m.content);
    const tool = m._toolName || wrappedTool;
    // Already on disk: an arrival view, or a swap_read result. It goes back
    // to its entry's stub instead of becoming a copy (the live run re-read
    // 30 pages and grew the index from 30 entries to 93).
    const readBack = tool === "swap_read" && raw.match(/^\[swap #(\d+) /);
    const original = (m._swap && store.get(m._swap)) || (readBack && store.get(Number(readBack[1])));
    if (original) {
      messages[i] = { ...m, content: stubFor(original), _swap: original.id };
      continue;
    }
    const { turn, call } = turnAndCall(messages, i);
    const r = readableOf(raw);
    const e = store.put({ turn, call, tool, kind: kindOf(tool), source: r.url || sourceOf(tool, callArgs(messages, i)), title: r.title || titleOf(r.text), text: r.text });
    messages[i] = { ...m, content: stubFor(e), _swap: e.id };
  }
  return plan.length;
}

// ── When swap is on ──────────────────────────────────────────

/**
 * Swap sleeps until the context reaches this many tokens: 75% of the lossy
 * compression's threshold, so swap acts first and that one is the last
 * resort. Measured 2026-10-02: always on, swap saved nothing on a 30-page run
 * (38k against 36k tokens a call) and made the agent read pages back.
 */
export function swapFromTokens({ env = process.env, compressThreshold = 64000, level = getSpendLevel(env) } = {}) {
  const v = parseInt(env.FLINT_SWAP_FROM, 10);
  if (Number.isFinite(v)) return v;
  return Math.floor(compressThreshold * spendSettings(level).swapFromShare);
}

export function swapActive(contextTokens, swapFrom) {
  return contextTokens >= swapFrom;
}

/** The context's size the way the budget counts it: characters / 4, tool calls included. */
export function contextTokensOf(messages) {
  let t = 0;
  for (const m of messages || []) {
    const c = m?.content;
    if (typeof c === "string") t += Math.ceil(c.length / 4);
    else if (c != null) t += Math.ceil(JSON.stringify(c).length / 4);
    if (m?.tool_calls) t += Math.ceil(JSON.stringify(m.tool_calls).length / 4);
  }
  return t;
}

// ── Conversation swap ────────────────────────────────────────

/** From the compression threshold (spend.js, `conv`); a third of that per chunk; 4 turns kept. */
export function convSettings({ env = process.env, window = null, level = getSpendLevel(env) } = {}) {
  const int = (v) => (Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : null);
  const high = int(env.FLINT_SWAP_CONV_HIGH) ?? windowShare(spendSettings(level).conv, window);
  return {
    high,
    chunk: int(env.FLINT_SWAP_CONV_CHUNK) ?? Math.floor(high / 3),
    keepTurns: int(env.FLINT_SWAP_CONV_KEEP) ?? 4,
  };
}

/** Turns: an operator's message and everything up to the next one, as index ranges. */
export function turnsOf(messages) {
  const starts = [];
  for (let i = 0; i < messages.length; i++) if (messages[i]?.role === "user") starts.push(i);
  return starts.map((s, k) => ({ start: s, end: k + 1 < starts.length ? starts[k + 1] : messages.length }));
}

/**
 * The oldest whole turns to move, about `chunk` tokens of them, or null when
 * the context is under `high`. Never the latest `keepTurns` turns, never the
 * system message or a stub (they come before the first turn).
 */
export function planConversationSwap(messages, { high, chunk, keepTurns = 4 } = {}) {
  if (contextTokensOf(messages) < high) return null;
  const turns = turnsOf(messages);
  const movable = turns.slice(0, Math.max(0, turns.length - keepTurns));
  if (!movable.length) return null;
  let tokens = 0;
  let k = 0;
  for (; k < movable.length; k++) {
    tokens += contextTokensOf(messages.slice(movable[k].start, movable[k].end));
    if (tokens >= chunk) break;
  }
  const last = movable[Math.min(k, movable.length - 1)];
  return { start: movable[0].start, end: last.end, count: Math.min(k, movable.length - 1) + 1 };
}

/** A readable transcript of messages; `tools: false` leaves tool results out. */
export function transcriptOf(messages, { tools = true } = {}) {
  const out = [];
  for (const m of messages) {
    const text = typeof m.content === "string" ? m.content : m.content == null ? "" : JSON.stringify(m.content);
    if (m.role === "user") out.push(`USER: ${text}`);
    else if (m.role === "assistant") {
      const calls = (m.tool_calls || []).map((c) => `${c.function?.name} ${c.function?.arguments || ""}`.trim());
      out.push(`ASSISTANT: ${[text, ...calls.map((c) => `[calls ${c}]`)].filter(Boolean).join("\n")}`);
    } else if (m.role === "tool") {
      if (tools) out.push(`TOOL (${m._toolName || unwrap(m.content).tool || "tool"}): ${unwrap(text).text}`);
    } else if (m.role === "system") out.push(`SYSTEM: ${text}`);
  }
  return out.join("\n\n");
}

const STAMP_TIME = /\[Local time: \w{3} \d{4}-\d\d-\d\d (\d\d:\d\d)/;
const STAMP_LINE = /^\[Local time: [^\]\n]*\]\n?/;

/**
 * Move the oldest whole turns to the swap as one `conversation` entry and put
 * one line in their place, after the system message and the earlier lines.
 * `summarize(text)` writes what the line says; when it fails, the first words
 * of the operator's messages do. Returns the entry, or null when nothing moved.
 */
export async function applyConversationSwap(messages, store, opts, summarize) {
  const plan = planConversationSwap(messages, opts);
  if (!plan) return null;
  const chunk = messages.slice(plan.start, plan.end);
  let before = 0;
  for (const m of messages.slice(0, plan.start)) if (m._conv && m._turnsTo > before) before = m._turnsTo;
  const from = before + 1;
  const to = before + plan.count;
  const times = chunk.filter((m) => m.role === "user").map((m) => String(m.content).match(STAMP_TIME)?.[1]).filter(Boolean);
  const span = times.length ? `, ${times[0]}-${times.at(-1)}` : "";

  let summary = "";
  try {
    // The head of every message, not the first 40k characters of the
    // transcript: one long message used to fill that, and the summary said
    // the rest of the chunk was "truncated" (live run, 2026-10-02).
    const heads = chunk.map((m) => (typeof m.content === "string" && m.content.length > 1500 ? { ...m, content: m.content.slice(0, 1500) + " …" } : m));
    summary = String((await summarize?.(transcriptOf(heads, { tools: false }).slice(0, 40000))) || "").replace(/\s+/g, " ").trim();
  } catch {}
  if (!summary) {
    summary = chunk.filter((m) => m.role === "user")
      .map((m) => String(m.content).replace(STAMP_LINE, "").trim().split(/\s+/).slice(0, 12).join(" "))
      .join(" | ")
      .slice(0, 240);
  }

  const turnNow = before + turnsOf(messages).length;
  const e = store.put({ turn: turnNow, call: 0, tool: "conversation", kind: "conversation", source: `turns ${from}-${to}${span}`, title: summary, text: transcriptOf(chunk) });
  messages.splice(plan.start, plan.end - plan.start, { role: "system", content: stubFor(e), _swap: e.id, _conv: true, _turnsTo: to });
  return e;
}
