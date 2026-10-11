// The optional fallback model.
//
// The operator may name a second model. When the main one is unavailable, the
// turn carries on with the second and says so; when none is named, nothing
// changes and the turn stops with its reason. "Unavailable" is narrow on
// purpose: the retries on the main model are used up on silence, on empty
// answers, on provider errors, or the provider does not serve the model. A
// refused key is not a reason to try another model with the same key.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMockStore } from "../helpers/mock-store.js";

const MAIN = "main/model";
const SPARE = "spare/model";

const cfg = vi.hoisted(() => ({
  apiKey: "test-key",
  model: "main/model",
  fallbackModel: null,
  provider: "openrouter",
  apiUrl: "https://test.api/v1/chat/completions",
  projectRoot: process.cwd(),
  sessionsDir: `${process.cwd()}/.tmp-fallback/sessions`,
  maxIterations: 50,
}));
vi.mock("../../src/config.js", () => ({ config: cfg }));
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

const enc = new TextEncoder();
function sse(delta) {
  const bytes = enc.encode(`data: ${JSON.stringify({ id: "gen-1", choices: [{ delta }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`);
  let sent = false;
  return new ReadableStream({ pull(c) { if (sent) { c.close(); return; } c.enqueue(bytes); sent = true; } });
}

// How a model behaves, as the provider would answer for it.
const answers = (text) => () => ({ ok: true, body: sse({ content: text }) });
const empty = () => ({ ok: true, body: new ReadableStream({ start(c) { c.enqueue(enc.encode("data: [DONE]\n\n")); c.close(); } }) });
const silent = (signal) => ({ ok: true, body: new ReadableStream({ start(c) { signal?.addEventListener("abort", () => { try { c.error(new Error("aborted")); } catch {} }, { once: true }); } }) });
const refuses = (status, text) => () => ({ ok: false, status, headers: { get: () => null }, text: async () => text });

/**
 * One turn (or several) against a provider where each model behaves as told.
 * Returns the models the agent loop asked, in order, and each turn's result.
 */
async function run(behaviour, { turns = 1, mainCard = null, listed = [] } = {}) {
  const asked = [];
  globalThis.fetch = vi.fn(async (url, init) => {
    // The provider's model list, where a model's own rate card comes from.
    if (!init?.body) return { ok: true, json: async () => ({ data: listed }) };
    const body = JSON.parse(init.body);
    // Side calls (the classifier and the like) carry no tools.
    if (!(body.tools || []).length) return { ok: true, body: sse({ content: "ok" }) };
    asked.push(body.model);
    const how = behaviour[body.model];
    if (!how) throw new Error("a model nobody configured was asked: " + body.model);
    return how(init.signal);
  });

  vi.resetModules();
  const { initRegistry } = await import("../../src/tools/registry.js");
  const { runAgent } = await import("../../src/agent/agent.js");
  initRegistry(createMockStore());
  const { setPricingSource } = await import("../../src/agent/usage.js");
  setPricingSource(() => mainCard);

  const notes = [];
  const results = [];
  const messages = [{ role: "system", content: "You are helpful" }];
  for (let n = 0; n < turns; n++) {
    messages.push({ role: "user", content: "Say hello." });
    results.push(await runAgent(messages, { onModelFallback: (info) => notes.push(info) }, { sessionId: "t-fallback" }));
  }
  return { asked, results, result: results[0], notes };
}

let originalFetch;
beforeEach(() => {
  originalFetch = globalThis.fetch;
  cfg.fallbackModel = null;
  process.env.FLINT_TOOL_MODE = "search";
  process.env.FLINT_API_RETRY_MS = "0";
  process.env.AGENT_BACKOFF_MS = "1";
  process.env.AGENT_FIRST_TOKEN_TIMEOUT_MS = "200";
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const k of ["FLINT_TOOL_MODE", "FLINT_API_RETRY_MS", "AGENT_BACKOFF_MS", "AGENT_FIRST_TOKEN_TIMEOUT_MS"]) delete process.env[k];
});

describe("a fallback model is set", () => {
  beforeEach(() => { cfg.fallbackModel = SPARE; });

  it.each([
    ["answers with nothing", empty, "empty", 3],
    ["is silent", silent, "stall", 3],
    ["fails at the provider", refuses(500, "upstream exploded"), "error", 3],
    ["is not served", refuses(404, "no such model"), "model-not-found", 1],
    ["stays rate limited", refuses(429, "slow down"), "rate-limit", 4],
  ])("the main model %s: the turn is finished by the fallback, and says so", async (_name, how, reason, mainCalls) => {
    const { asked, result, notes } = await run({ [MAIN]: how, [SPARE]: answers("hello from the spare") });
    expect(asked).toEqual([...Array(mainCalls).fill(MAIN), SPARE]);
    expect(result.stop_reason).toBe("done");
    expect(result.text).toContain("hello from the spare");
    expect(result.fallback).toMatchObject({ from: MAIN, to: SPARE, reason });
    // Said where the operator reads, with both names.
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ from: MAIN, to: SPARE, reason });
    expect(notes[0].text).toContain(MAIN);
    expect(notes[0].text).toContain(SPARE);
  }, 30000);

  it("a refused key does not switch the model: the same key would be refused again", async () => {
    const { asked, result } = await run({ [MAIN]: refuses(401, "bad key"), [SPARE]: answers("should not be asked") });
    expect(asked).toEqual([MAIN]);
    expect(result.stop_reason).toBe("auth");
    expect(result.fallback).toBeNull();
  }, 30000);

  it("the fallback fails the same way: the turn stops and names both models", async () => {
    const { asked, result } = await run({ [MAIN]: empty, [SPARE]: empty });
    expect(asked).toEqual([MAIN, MAIN, MAIN, SPARE, SPARE, SPARE]);
    expect(result.stop_reason).toBe("empty");
    expect(result.text).toContain(MAIN);
    expect(result.text).toContain(SPARE);
    expect(result.fallback).toMatchObject({ from: MAIN, to: SPARE });
  }, 30000);

  it("the next turn starts on the main model again", async () => {
    const { asked, results } = await run({ [MAIN]: empty, [SPARE]: answers("hello from the spare") }, { turns: 2 });
    expect(asked).toEqual([MAIN, MAIN, MAIN, SPARE, MAIN, MAIN, MAIN, SPARE]);
    expect(results[1].fallback).toMatchObject({ from: MAIN, to: SPARE });
  }, 30000);

  // The provider in this test reports no cost, so the call is priced from a
  // rate card: 10 prompt tokens and 5 completion tokens on the spare.
  const DEAR = { prompt: 0.01, completion: 0.01 };

  it("a call on the fallback is priced by its own card, not the main model's", async () => {
    const { result } = await run(
      { [MAIN]: empty, [SPARE]: answers("hello from the spare") },
      { mainCard: DEAR, listed: [{ id: SPARE, pricing: { prompt: "0.000002", completion: "0.000004" } }] },
    );
    expect(result.fallback).toMatchObject({ to: SPARE });
    expect(result.stats.cost).toBeCloseTo(10 * 0.000002 + 5 * 0.000004, 10);
  }, 30000);

  it("a fallback the provider lists no price for costs 0 rather than the main model's price", async () => {
    const { result } = await run({ [MAIN]: empty, [SPARE]: answers("hello from the spare") }, { mainCard: DEAR });
    expect(result.fallback).toMatchObject({ to: SPARE });
    expect(result.stats.cost).toBe(0);
  }, 30000);

  it("a main model that works is never left", async () => {
    const { asked, result } = await run({ [MAIN]: answers("hello from the main"), [SPARE]: answers("should not be asked") });
    expect(asked).toEqual([MAIN]);
    expect(result.fallback).toBeNull();
  }, 30000);
});

describe("no fallback model is set", () => {
  it("the turn stops with its reason, and no other model is asked", async () => {
    const { asked, result } = await run({ [MAIN]: empty });
    expect(asked).toEqual([MAIN, MAIN, MAIN]);
    expect(result.stop_reason).toBe("empty");
    expect(result.fallback).toBeNull();
  }, 30000);
});
