// Context swap in the real agent loop (docs/context-swap.md, A1-A4, A8).
//
// The model is stubbed: it asks for 30 pages, one call each, then answers.
// Each page is 11 KB. What the loop sends the model is captured call by call.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createMockStore } from "../helpers/mock-store.js";

const { SESSIONS } = vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs");
  const { tmpdir } = require("node:os");
  const { join } = require("node:path");
  return { SESSIONS: mkdtempSync(join(tmpdir(), "flint-swap-loop-")) };
});

vi.mock("../../src/config.js", () => ({
  config: {
    apiKey: "test-key",
    model: "test-model",
    apiUrl: "https://test.api/v1/chat/completions",
    projectRoot: process.cwd(),
    sessionsDir: SESSIONS,
    maxIterations: 80,
    compressAfterTokens: 10_000_000,   // today's compression stays out of the way
  },
}));
vi.mock("../../src/agent/modes.js", () => ({ getModeForIntent: () => null, listModes: () => [] }));
vi.mock("../../src/memory/store.js", () => ({
  loadAll: () => [], insertMemory: () => ({}), searchMemories: () => [], getMemory: () => null,
  listRecentMemories: () => [], deleteMemory: () => false,
  getMemoryStats: () => ({ total: 0, byCategory: {}, oldest: null, newest: null }),
  clearAllMemories: vi.fn(),
}));
vi.mock("../../src/memory/markdown.js", () => ({ updateMemoryMd: vi.fn(), readMemoryMdHead: () => "" }));
vi.mock("../../src/memory/facts.js", () => ({ extractFacts: () => [], addFact: () => {}, formatForPrompt: () => "" }));
vi.mock("../../src/memory/user-model.js", () => ({ observeUser: () => {}, formatForPrompt: () => "" }));
vi.mock("../../src/memory/patterns.js", () => ({ recordPattern: () => {}, compilePreferences: () => ({}), formatForPrompt: () => "" }));

const PAGES = 30;
// ~11 KB, and no trailing space: the loop trims tool results.
const page = (n) => `# Page ${n}\n\n` + `word${n} `.repeat(1900) + "end";

function sse(delta) {
  const text = `data: ${JSON.stringify({ id: "gen-1", choices: [{ delta }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`;
  const bytes = new TextEncoder().encode(text);
  let done = false;
  return new ReadableStream({ pull(c) { if (done) { c.close(); return; } c.enqueue(bytes); done = true; } });
}

/** Run the 30-page turn; return the payloads the model was sent. */
async function run(sessionId, env = {}) {
  for (const k of ["FLINT_SWAP", "FLINT_SWAP_RESULT_MAX", "FLINT_SWAP_BUDGET", "FLINT_SWAP_LOW_WATER", "FLINT_SWAP_FROM"]) delete process.env[k];
  Object.assign(process.env, env);
  vi.resetModules();
  const payloads = [];
  let n = 0;
  globalThis.fetch = vi.fn(async (url, init) => {
    const body = JSON.parse(init.body);
    if (!(body.tools || []).length) return { ok: true, body: sse({ content: "ok" }) };   // side questions
    payloads.push(body.messages);
    n++;
    const delta = n <= PAGES
      ? { tool_calls: [{ index: 0, id: `call${n}`, function: { name: "mcp_test_read_page", arguments: JSON.stringify({ url: `https://example.com/p${n}` }) } }] }
      : { content: "Read all pages." };
    return { ok: true, body: sse(delta) };
  });
  const { initRegistry, registerMcpTools } = await import("../../src/tools/registry.js");
  const { runAgent } = await import("../../src/agent/agent.js");
  initRegistry(createMockStore());
  registerMcpTools(
    [{ type: "function", function: { name: "mcp_test_read_page", description: "Read a web page", parameters: { type: "object", properties: { url: { type: "string" } } } } }],
    { mcp_test_read_page: async ({ url }) => page(Number(url.match(/p(\d+)$/)[1])) },
    [],
  );
  const messages = [
    { role: "system", content: "You are helpful" },
    { role: "user", content: "Read pages 1 to 30." },
  ];
  await runAgent(messages, {}, { sessionId });
  return payloads;
}

const toolTokens = (msgs) => msgs.filter((m) => m.role === "tool").reduce((s, m) => s + Math.ceil(String(m.content).length / 4), 0);
const latestCallTokens = (msgs) => {
  const lastCall = msgs.map((m) => m.role === "assistant" && m.tool_calls?.length).lastIndexOf(true);
  return msgs.slice(lastCall + 1).filter((m) => m.role === "tool").reduce((s, m) => s + Math.ceil(String(m.content).length / 4), 0);
};
// A steering note rides at the end of one payload only (agent.js "nudge"),
// so it is left out of the comparison.
const withoutNudge = (msgs) => { const a = [...msgs]; while (a.length && a.at(-1).role === "system") a.pop(); return a; };
const isPrefix = (prev, next) => { const a = withoutNudge(prev); return a.length <= next.length && a.every((m, i) => JSON.stringify(m) === JSON.stringify(next[i])); };

let originalFetch;
beforeEach(() => { originalFetch = globalThis.fetch; });
afterEach(() => { globalThis.fetch = originalFetch; for (const k of ["FLINT_SWAP", "FLINT_SWAP_RESULT_MAX", "FLINT_SWAP_BUDGET", "FLINT_SWAP_LOW_WATER", "FLINT_SWAP_FROM"]) delete process.env[k]; });

describe("swap in the agent loop", () => {
  it("A1-A3 with eviction: bounded, nothing lost, rewrites in batches", async () => {
    const budget = 20000;
    // Pages are under resultMax here, so they arrive whole and eviction does the work.
    const payloads = await run("swap-evict", { FLINT_SWAP_FROM: "0", FLINT_SWAP_RESULT_MAX: "65536", FLINT_SWAP_BUDGET: String(budget) });
    expect(payloads.length).toBe(PAGES + 1);
    for (const p of payloads) expect(toolTokens(p)).toBeLessThanOrEqual(budget + latestCallTokens(p));   // A1

    let rewrites = 0;
    for (let i = 1; i < payloads.length; i++) if (!isPrefix(payloads[i - 1], payloads[i])) rewrites++;
    expect(rewrites).toBeLessThan(payloads.length / 3);                                                  // A3

    const dir = path.join(SESSIONS, "swap-evict", "swap");
    const { createSwapStore } = await import("../../src/agent/swap.js");
    const store = createSwapStore(dir);
    const swapped = store.list();
    expect(swapped.length).toBeGreaterThan(0);
    for (const e of swapped) expect(store.read(e.id)).toBe(page(Number(e.source.match(/p(\d+)$/)[1])));    // A2
    // Every page is either still whole in the last payload or in the store.
    const last = payloads.at(-1);
    for (let k = 1; k <= PAGES; k++) {
      const whole = last.some((m) => m.role === "tool" && String(m.content).includes(`# Page ${k}\n`));
      const stored = swapped.some((e) => e.source === `https://example.com/p${k}`);
      expect(whole || stored, `page ${k}`).toBe(true);
    }
  }, 60000);

  it("A8 on arrival: a page over resultMax reaches the history as stub, head and outline", async () => {
    const payloads = await run("swap-arrival", { FLINT_SWAP_FROM: "0", FLINT_SWAP_RESULT_MAX: "8192" });
    const second = payloads[1];
    const result = second.find((m) => m.role === "tool");
    expect(String(result.content)).toMatch(/\[swap #1 · page · https:\/\/example\.com\/p1 · 11\.\d KB · "Page 1" · turn 1 · swap_read 1\]/);
    expect(String(result.content).length).toBeLessThan(page(1).length / 2);
    const index = readFileSync(path.join(SESSIONS, "swap-arrival", "swap", "index.jsonl"), "utf8").trim().split("\n");
    expect(index).toHaveLength(PAGES);
  }, 60000);

  it("B1/B2 dormant below swapFrom, then it engages", async () => {
    const from = 30000;
    const off = await run("b-off", { FLINT_SWAP: "0" });
    const on = await run("b-on", { FLINT_SWAP_FROM: String(from), FLINT_SWAP_RESULT_MAX: "8192" });
    const { contextTokensOf } = await import("../../src/agent/swap.js");
    let k = 0;
    while (k < off.length && contextTokensOf(off[k]) < from - 3000) {
      expect(JSON.stringify(on[k]), `payload ${k} below swapFrom`).toBe(JSON.stringify(off[k]));   // B1
      k++;
    }
    expect(k).toBeGreaterThan(3);
    expect(on.at(-1).some((m) => /\[swap #/.test(String(m.content)))).toBe(true);                // B2
    expect(contextTokensOf(on.at(-1))).toBeLessThan(contextTokensOf(off.at(-1)));
  }, 90000);

  it("A4 off is off: FLINT_SWAP=0 keeps every page whole and writes no swap folder", async () => {
    const payloads = await run("swap-off", { FLINT_SWAP: "0" });
    const last = payloads.at(-1);
    for (let k = 1; k <= PAGES; k++) expect(last.some((m) => m.role === "tool" && String(m.content).includes(page(k)))).toBe(true);
    expect(last.some((m) => /\[swap #/.test(String(m.content)))).toBe(false);
    expect(existsSync(path.join(SESSIONS, "swap-off", "swap"))).toBe(false);
    expect(toolTokens(last)).toBeGreaterThan(20000);   // what swap keeps down
    for (let i = 1; i < payloads.length; i++) expect(isPrefix(payloads[i - 1], payloads[i])).toBe(true);
  }, 60000);
});

describe("the swap rule in the system prompt", () => {
  it("is there with swap on and gone with FLINT_SWAP=0 (A4)", async () => {
    const load = async (env) => {
      delete process.env.FLINT_SWAP;
      Object.assign(process.env, env);
      vi.resetModules();
      const { getSystemMessage } = await import("../../src/agent/system-prompt.js");
      return JSON.stringify(getSystemMessage(null, {}));
    };
    expect(await load({})).toContain("swap_read");
    expect(await load({ FLINT_SWAP: "0" })).not.toContain("swap_read");
    delete process.env.FLINT_SWAP;
  }, 30000);
});
