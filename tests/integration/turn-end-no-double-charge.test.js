// Guards message-handler.js at the end of a turn. Every provider call is
// charged to the session store live (client.js: recordUsage -> applyUsage); the
// end-of-turn drain is for the receipt only. If processMessage merged the drain
// into the store again (addUsage), every call would be charged twice. The older
// live-cost-counter test drives runAgent directly and never reaches that line,
// so reverting it stayed green.
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../../src/logging/logger.js", () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}));

async function turnWith(calls) {
  const { store } = await import("../../src/store/index.js");
  store.getState().resetSession("end-of-turn-test", []);
  const agent = await import("../../src/agent/agent.js");
  const { recordUsage } = await import("../../src/agent/usage.js");
  vi.spyOn(agent, "runAgent").mockImplementation(async (messages) => {
    // What the door in client.js does for each provider call.
    for (const usage of calls) {
      const entry = recordUsage("agent", usage);
      if (entry) store.getState().applyUsage("agent", entry);
    }
    messages.push({ role: "assistant", content: "ok" });
    return { text: "ok", stats: { generationIds: [] } };
  });
  const { processMessage } = await import("../../src/message-handler.js");
  await processMessage("question", null);
  return store.getState();
}

describe("end of a turn", () => {
  afterEach(() => vi.restoreAllMocks());

  it("charges each call to the session once", async () => {
    const s = await turnWith([
      { prompt_tokens: 10, completion_tokens: 5, cost: 0.001 },
      { prompt_tokens: 20, completion_tokens: 10, cost: 0.002 },
    ]);
    expect(s.sessionCost).toBeCloseTo(0.003, 10);
    expect(s.sessionUsageBySource.agent.calls).toBe(2);
    expect(s.sessionPromptTokens).toBe(30);
  }, 30000);

  it("a call with no usage object still counts and marks the session estimated", async () => {
    const s = await turnWith([
      { prompt_tokens: 10, completion_tokens: 5, cost: 0.001 },
      null,
    ]);
    expect(s.sessionUsageBySource.agent.calls).toBe(2);
    expect(s.sessionCostEstimated).toBe(true);
    expect(s.sessionUsageBySource.agent.estimated).toBe(true);
    expect(s.sessionCost).toBeCloseTo(0.001, 10);
  }, 30000);
});
