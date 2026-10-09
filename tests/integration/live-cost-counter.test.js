// Live cost counter.
//
// The cost shown in the status line, /status and the API usage block must grow
// after EACH provider call during a turn, not only once the turn ends. Today the
// in-memory ledger in src/agent/usage.js is updated live by recordUsage (called
// from src/api/client.js), but the store — the thing /status, the status line
// and the API usage block read — is only topped up once, at the end of the turn,
// by drainUsage()+addUsage() in src/message-handler.js. The fix pushes the
// per-call delta into the store right after each call, and must NOT double-count
// at turn end (the end-of-turn drain must become a no-op for what the live push
// already accounted for).
//
// This test runs a real agent turn (real process behaviour, real chatCompletion
// door) against a fake provider whose scripted responses each carry a cost, and
// watches store.getState().sessionCost climb between calls. The provider is faked
// at the fetch layer (globalThis.fetch), exactly as agent-loop.test.js does, so
// the real accounting code path runs.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMockStore } from "../helpers/mock-store.js";
import { createTmpDir } from "../helpers/tmp-dir.js";
import { drainUsage, sumUsage } from "../../src/agent/usage.js";

// The config and memory mocks isolate the turn from the filesystem / keys so
// the only money that moves is what the fake provider reports.
vi.mock("../../src/config.js", () => ({
  config: {
    apiKey: "test-key",
    model: "test-model",
    provider: "openrouter",
    maxResponseTokens: 500,
    maxCostPerAction: 0,
    sessionBudget: 0,
    openrouterProvider: null,
    freeChain: null,
    sessionsDir: null,
    permissionsFile: null,
  },
}));

vi.mock("../../src/memory/store.js", () => ({
  loadAll: () => [],
  insertMemory: () => ({ id: 1, content: "", category: "general", importance: 1, created_at: new Date().toISOString() }),
  searchMemories: () => [],
  getMemory: () => null,
  listRecentMemories: () => [],
  deleteMemory: () => false,
  getMemoryStats: () => ({ total: 0, byCategory: {}, oldest: null, newest: null }),
  clearAllMemories: vi.fn(),
}));

vi.mock("../../src/memory/markdown.js", () => ({
  updateMemoryMd: vi.fn(),
  readMemoryMdHead: () => "",
}));

vi.mock("../../src/memory/facts.js", () => ({
  extractFacts: () => [],
  addFact: () => {},
  formatForPrompt: () => "",
}));

vi.mock("../../src/memory/user-model.js", () => ({
  observeUser: () => {},
  formatForPrompt: () => "",
}));

vi.mock("../../src/memory/patterns.js", () => ({
  recordPattern: () => {},
  compilePreferences: () => ({}),
  formatForPrompt: () => "",
}));

vi.mock("../../src/agent/intent.js", () => ({
  classifyIntent: async () => ({ intent: "complex_multi", tools: [], max_steps: 50, changes: "no", fallback: true }),
  filterToolsByManifest: (defs) => defs,
  formatIntentHint: () => "",
}));

vi.mock("../../src/agent/modes.js", () => ({
  getModeForIntent: () => null,
  listModes: () => [],
}));

function buildSSE(chunks) {
  const lines = [];
  for (const chunk of chunks) lines.push(`data: ${JSON.stringify(chunk)}\n\n`);
  lines.push("data: [DONE]\n\n");
  return lines.join("");
}

function sseStream(text) {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) { controller.close(); return; }
      controller.enqueue(bytes.slice(offset, offset + 256));
      offset += 256;
    },
  });
}

const COSTS = [0.001, 0.002, 0.004]; // three calls, 7 thousandths total

let tmp;
let originalFetch;
// The singleton store is what runAgent + client.js actually write through
// applyUsage. The test reads THIS, not a mock, so it observes the live counter.
let singletonStore;
// Snapshots of sessionCost captured after each provider call returns.
let observedBetweenCalls;
// The sum of costs reported by every call the fake provider served.
let totalProviderCost;

beforeEach(async () => {
  tmp = createTmpDir();
  originalFetch = globalThis.fetch;
  // Fresh singleton store for each test: reset the session to zero cost so the
  // counter starts clean (no session is restored because config/sessions are
  // mocked and no session file exists in the sandbox).
  const { store } = await import("../../src/store/index.js");
  singletonStore = store;
  singletonStore.getState().resetSession("live-cost-test", [{ role: "user", content: "hi" }]);
  observedBetweenCalls = [];
  totalProviderCost = 0;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  tmp.cleanup();
});

describe("live cost counter during a turn", () => {
  it("sessionCost grows after each provider call and ends at the sum, with no double count", async () => {
    const { initRegistry } = await import("../../src/tools/registry.js");
    const { runAgent } = await import("../../src/agent/agent.js");
    // Tool registry state is independent of the usage store; a throwaway mock
    // store is fine here — what matters for the counter is the singleton above.
    initRegistry(createMockStore());

    // A turn that calls the provider three times:
    //  1. a think,
    //  2. a read_file tool call,
    //  3. a final text answer.
    const { writeFileSync } = await import("node:fs");
    const testFile = tmp.path + "/data.txt";
    writeFileSync(testFile, "hello world", "utf-8");

    let callIndex = 0;
    globalThis.fetch = vi.fn(async () => {
      // Snapshot the live store total at the START of each call: by the time
      // the agent loop fires the next fetch, the previous chatCompletion has
      // already returned — which means recordUsage + the live applyUsage push
      // have both run, updating the store. The snapshot for call N therefore
      // reflects calls 1..N-1 (i.e. it lags by one), so we pad the front with 0
      // and append the final total after the turn ends.
      observedBetweenCalls.push((singletonStore.getState().sessionCost || 0));

      callIndex += 1;
      const cost = COSTS[callIndex - 1];
      totalProviderCost += cost;

      let sse;
      if (callIndex === 1) {
        // think tool call
        sse = buildSSE([
          { id: "gen-1", choices: [{ delta: {
            tool_calls: [{ index: 0, id: "call_think",
              function: { name: "think", arguments: JSON.stringify({ thought: "planning" }) } }],
          } }], usage: { prompt_tokens: 10, completion_tokens: 5, cost } },
        ]);
      } else if (callIndex === 2) {
        sse = buildSSE([
          { id: "gen-2", choices: [{ delta: {
            tool_calls: [{ index: 0, id: "call_read",
              function: { name: "read_file", arguments: JSON.stringify({ path: testFile }) } }],
          } }], usage: { prompt_tokens: 20, completion_tokens: 10, cost } },
        ]);
      } else {
        sse = buildSSE([
          { id: "gen-3", choices: [{ delta: { content: "The file says: hello world" } }], usage: { prompt_tokens: 30, completion_tokens: 15, cost } },
        ]);
      }

      const resp = {
        ok: true,
        status: 200,
        body: sseStream(sse),
        headers: new Headers({ "content-type": "text/event-stream" }),
        text: async () => sse,
      };
      return resp;
    });

    const messages = [
      { role: "system", content: "You are helpful" },
      { role: "user", content: "Read the file" },
    ];
    const result = await runAgent(messages, {});

    expect(result.text).toBe("The file says: hello world");

    // Three provider calls were made.
    expect(callIndex).toBe(3);
    expect(totalProviderCost).toBeCloseTo(0.001 + 0.002 + 0.004, 10);

    // Live: snapshots are taken at the START of each fetch (see mock), so they
    // lag by one call — snapshot[0] is the idle 0 before call 1, snapshot[1] is
    // after call 1, snapshot[2] after call 2. Append the final post-turn total.
    const afterTurn = singletonStore.getState().sessionCost || 0;
    const seen = [...observedBetweenCalls, afterTurn];
    // After each completed call the total must equal the running sum of costs
    // reported so far — strictly increasing, no zero plateau mid-turn.
    const expectedPartials = [0, COSTS[0], COSTS[0] + COSTS[1], COSTS[0] + COSTS[1] + COSTS[2]];
    expect(seen).toHaveLength(4);
    for (let i = 0; i < 4; i++) {
      expect(seen[i]).toBeCloseTo(expectedPartials[i], 10);
    }
    // No plateau: each step must be strictly greater than the last.
    expect(seen[2]).toBeGreaterThan(seen[1]);
    expect(seen[3]).toBeGreaterThan(seen[2]);

    // End of turn: the total must equal the sum ONCE, not twice. Matching the
    // provider sum proves the end-of-turn drain did not double-count the live
    // pushes.
    expect(seen[3]).toBeCloseTo(totalProviderCost, 10);

    // And the per-source breakdown is live too: the agent source must carry
    // all three calls.
    const bySource = singletonStore.getState().sessionUsageBySource;
    expect(bySource?.agent?.calls).toBe(3);
    expect(bySource?.agent?.cost).toBeCloseTo(totalProviderCost, 10);
  });

  // Test 2 (per the task): after the turn ends, the result is the same as
  // before the change for the same calls. Before the fix the store was updated
  // only at turn end via drainUsage()+addUsage(); the final session total was
  // the sum of all calls. The fix must not change that final number — it only
  // adds live updates mid-turn — so the end-of-turn total and per-source split
  // must match the pre-change end-of-turn result exactly.
  it("end-of-turn total equals the sum with no double count and carries estimated", async () => {
    const { initRegistry } = await import("../../src/tools/registry.js");
    const { runAgent } = await import("../../src/agent/agent.js");
    initRegistry(createMockStore());

    const { writeFileSync } = await import("node:fs");
    const testFile = tmp.path + "/data.txt";
    writeFileSync(testFile, "ok", "utf-8");

    // Same three costs, but the last call omits `cost` so it is estimated by
    // the local rate card. The end-of-turn total must still equal the provider's
    // number for the two reported calls plus the estimate for the third, and
    // the source must be flagged estimated — unchanged from the pre-fix path.
    let callIndex = 0;
    let sse_text = "";
    globalThis.fetch = vi.fn(async () => {
      callIndex += 1;
      let cost, usage;
      if (callIndex === 1) {
        cost = COSTS[0];
        usage = { prompt_tokens: 10, completion_tokens: 5, cost };
        sse_text = buildSSE([
          { id: "gen-1", choices: [{ delta: { tool_calls: [{ index: 0, id: "call_think1", function: { name: "think", arguments: JSON.stringify({ thought: "planning" }) } }] } }], usage },
        ]);
      } else if (callIndex === 2) {
        cost = COSTS[1];
        usage = { prompt_tokens: 20, completion_tokens: 10, cost };
        sse_text = buildSSE([
          { id: "gen-2", choices: [{ delta: { tool_calls: [{ index: 0, id: "call_think2", function: { name: "think", arguments: JSON.stringify({ thought: "still planning" }) } }] } }], usage },
        ]);
      } else {
        // No cost from provider -> estimated via the local rate card.
        usage = { prompt_tokens: 30, completion_tokens: 15 };
        sse_text = buildSSE([
          { id: "gen-3", choices: [{ delta: { content: "final answer" } }], usage },
        ]);
      }
      const resp = {
        ok: true,
        status: 200,
        body: sseStream(sse_text),
        headers: new Headers({ "content-type": "text/event-stream" }),
        text: async () => sse_text,
      };
      return resp;
    });

    const messages = [
      { role: "system", content: "You are helpful" },
      { role: "user", content: "Read the file" },
    ];
    const result = await runAgent(messages, {});

    expect(result.text).toBe("final answer");
    expect(callIndex).toBe(3);

    // The end-of-turn session total must be the same as before the change for
    // the same calls: the sum of the two provider-reported costs plus the
    // estimate for the cost-less third call. Before the fix the store was fed
    // only by the end-of-turn drainUsage()+addUsage(); the fix feeds it live
    // per call instead, and the turn-end drain is now a receipt-only no-op —
    // so the final total is unchanged.
    const afterRunDrained = drainUsage();
    const drainedTurnCost = sumUsage(afterRunDrained).cost;

    const ss = singletonStore.getState();
    const expected = COSTS[0] + COSTS[1]; // + estimated third call
    // The drained turn ledger holds the same calls the live push already moved
    // into the session total. If addUsage(drain) still ran at turn end it would
    // add drainedTurnCost ON TOP of the live total (2x); the live total and the
    // drained turn cost must therefore be equal, and equal the session total.
    expect(ss.sessionCost).toBeCloseTo(drainedTurnCost, 10);
    expect(ss.sessionCost).toBeGreaterThanOrEqual(expected);

    // Per-source split: agent source carries all three calls (the third as
    // estimated), exactly as the pre-fix end-of-turn drain recorded.
    const bySource = ss.sessionUsageBySource;
    expect(bySource?.agent?.calls).toBe(3);
    expect(bySource?.agent?.estimated).toBe(true);

    // No double count: the live-pushed session total equals the drained turn
    // cost (not 2x). The two reported calls alone are a known slice; the third
    // is estimated; the total is the sum once.
    expect(ss.sessionCost).toBeLessThan(2 * expected);
  });
});
