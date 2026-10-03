import { describe, it, expect, beforeEach } from "vitest";
import { createMockStore } from "../../helpers/mock-store.js";

let store;

beforeEach(() => {
  store = createMockStore();
});

describe("session-slice", () => {
  it("setSession sets id, messages, inputHistory", () => {
    store.getState().setSession("test-id", [{ role: "user", content: "hi" }], ["prev"]);
    const s = store.getState();
    expect(s.sessionId).toBe("test-id");
    expect(s.messages).toHaveLength(1);
    expect(s.inputHistory).toEqual(["prev"]);
  });

  it("pushMessage appends to messages", () => {
    store.getState().pushMessage({ role: "user", content: "a" });
    store.getState().pushMessage({ role: "assistant", content: "b" });
    expect(store.getState().messages).toHaveLength(2);
  });

  // One drained ledger per turn, every source in it. The store
  // adds nothing up of its own: it folds in what the notebook recorded.
  it("addUsage accumulates tokens and cost across sources", () => {
    store.getState().addUsage({
      agent: { calls: 1, promptTokens: 100, completionTokens: 50, cost: 0.01 },
    });
    store.getState().addUsage({
      agent: { calls: 1, promptTokens: 200, completionTokens: 100, cost: 0.015 },
      classifier: { calls: 1, promptTokens: 0, completionTokens: 0, cost: 0.005 },
    });
    const s = store.getState();
    expect(s.sessionPromptTokens).toBe(300);
    expect(s.sessionCompletionTokens).toBe(150);
    expect(s.sessionCost).toBeCloseTo(0.03);
    expect(s.sessionUsageBySource.agent.calls).toBe(2);
    expect(s.sessionUsageBySource.classifier.cost).toBeCloseTo(0.005);
  });

  it("pushInputHistory adds entries", () => {
    store.getState().pushInputHistory("cmd1");
    store.getState().pushInputHistory("cmd2");
    expect(store.getState().inputHistory).toEqual(["cmd1", "cmd2"]);
  });

  it("resetSession clears cost and tokens", () => {
    store.getState().addUsage({ agent: { calls: 1, promptTokens: 100, completionTokens: 50, cost: 0.05 } });
    store.getState().resetSession("new-id", []);
    const s = store.getState();
    expect(s.sessionId).toBe("new-id");
    expect(s.sessionCost).toBe(0);
    expect(s.sessionPromptTokens).toBe(0);
    expect(s.sessionCompletionTokens).toBe(0);
  });

  it("setModel updates model", () => {
    store.getState().setModel("gpt-4o");
    expect(store.getState().model).toBe("gpt-4o");
  });

  it("setPricing sets pricing and contextLimit", () => {
    store.getState().setPricing({ prompt: 0.001, completion: 0.002, contextLength: 128000 });
    const s = store.getState();
    expect(s.pricing.prompt).toBe(0.001);
    expect(s.contextLimit).toBe(128000);
  });
});
