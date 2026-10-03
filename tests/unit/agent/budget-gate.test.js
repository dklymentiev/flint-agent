// The budget refusal, tested where it has to hold: BEFORE the request leaves.
//
// The behaviour these tests pin down is the one that cost real money twice.
// Until the door existed, the ceiling was checked after a turn, against a
// number the checker had computed itself, and four modules spent outside that
// number entirely. "Budget exhausted" therefore meant "the main loop will stop
// eventually", not "nothing more will be bought".
//
// So the assertions are about `fetch`, not about return values. A test that
// only checks what a function returned cannot tell a refusal from a call that
// was made and then regretted.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../../src/config.js", () => ({
  config: {
    apiKey: "test-key",
    model: "main-model",
    intentModel: "cheap-model",
    extractionModel: "cheap-model",
    apiUrl: "https://test.api/v1/chat/completions",
    provider: "openrouter",
    maxResponseTokens: 2048,
    maxIterations: 30,
    maxCostPerAction: 0,
    sessionBudget: 0,
    headless: false,
    fallbackAllTools: false,
  },
}));

vi.mock("../../../src/providers/registry.js", () => ({
  getProvider: () => ({
    id: "openrouter",
    name: "OpenRouter",
    format: "openai",
    baseUrl: "https://test.api/v1",
    authType: "bearer",
    headers: {},
    defaultModel: "main-model",
  }),
  listProviders: () => [],
}));

vi.mock("../../../src/providers/models.js", () => ({
  fetchModelInfo: async () => null,
}));

const { config } = await import("../../../src/config.js");
const { chatCompletion } = await import("../../../src/api/client.js");
const { classifyIntent } = await import("../../../src/agent/intent.js");
const {
  recordUsage,
  resetSessionSpend,
  beginAction,
  beginRun,
  endRun,
  getSpend,
  overBudget,
  BudgetExceededError,
} = await import("../../../src/agent/usage.js");

// One dollar spent, priced by the provider so nothing is an estimate.
function spend(dollars) {
  recordUsage("agent", { prompt_tokens: 1000, completion_tokens: 100, cost: dollars });
}

function jsonReply(content) {
  return {
    ok: true,
    json: async () => ({
      id: "gen-1",
      choices: [{ message: { role: "assistant", content } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.001 },
    }),
  };
}

let originalFetch;
let fetchMock;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  fetchMock = vi.fn(async () => jsonReply('{"intent":"chat","tools":[],"max_steps":3}'));
  globalThis.fetch = fetchMock;
  resetSessionSpend();
  config.maxCostPerAction = 0;
  config.sessionBudget = 0;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  endRun();
  resetSessionSpend();
});

describe("the ledger", () => {
  it("moves all three windows on one call", () => {
    beginRun(10);
    beginAction();
    spend(0.25);
    expect(getSpend()).toEqual({ action: 0.25, session: 0.25, run: 0.25 });
  });

  it("beginAction clears the turn, not the session", () => {
    spend(0.25);
    beginAction();
    spend(0.10);
    const s = getSpend();
    expect(s.action).toBeCloseTo(0.10);
    expect(s.session).toBeCloseTo(0.35);
  });

  it("counts a run only while one is open", () => {
    spend(0.20);
    beginRun(1);
    spend(0.30);
    expect(getSpend().run).toBeCloseTo(0.30);
    endRun();
    spend(0.40);
    expect(getSpend().session).toBeCloseTo(0.90);
  });

  it("names the ceiling that was hit, and reports none when all are clear", () => {
    spend(0.50);
    expect(overBudget({ perAction: 1, session: 1 })).toBe(null);
    expect(overBudget({ perAction: 0.5 })).toMatchObject({ scope: "action", limit: 0.5 });
    expect(overBudget({ session: 0.4 })).toMatchObject({ scope: "session", limit: 0.4 });
  });

  it("treats 0 as unlimited, which is what the config default means", () => {
    spend(1000);
    expect(overBudget({ perAction: 0, session: 0 })).toBe(null);
  });
});

describe("the door", () => {
  it("does not send the request when the per-action ceiling is spent", async () => {
    config.maxCostPerAction = 0.5;
    spend(0.6);

    await expect(chatCompletion([{ role: "user", content: "hi" }], [], null, { source: "agent" }))
      .rejects.toThrow(BudgetExceededError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not send the request when the session ceiling is spent", async () => {
    config.sessionBudget = 1;
    spend(1.2);

    await expect(chatCompletion([{ role: "user", content: "hi" }], [], null, { source: "agent" }))
      .rejects.toThrow(/session/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not send the request when the run ceiling is spent", async () => {
    beginRun(0.2);
    spend(0.25);

    await expect(chatCompletion([{ role: "user", content: "hi" }], [], null, { source: "agent" }))
      .rejects.toThrow(/run/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("records what the call cost without the caller doing anything", async () => {
    await chatCompletion([{ role: "user", content: "hi" }], [], null, { source: "classifier", stream: false });
    expect(getSpend().session).toBeCloseTo(0.001);
  });

  it("lets the call through while there is budget left", async () => {
    config.maxCostPerAction = 1;
    spend(0.2);
    await chatCompletion([{ role: "user", content: "hi" }], [], null, { source: "agent", stream: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("a side call on an exhausted budget", () => {
  // THE regression. Before the budget gate the classifier had its own fetch and no
  // ceiling anywhere near it: an agent stopped at its budget would still buy a
  // classification for every message the operator sent afterwards.
  it("the classifier does not reach the provider", async () => {
    config.sessionBudget = 1;
    spend(1.5);

    const manifest = await classifyIntent({
      newMessage: "unique message for the exhausted-budget case",
      sessionSummary: null,
      recentMessages: [],
      availableTools: [{ type: "function", function: { name: "read_file", description: "read" } }],
    });

    expect(fetchMock).not.toHaveBeenCalled();
    // It still answers: a refusal to spend must not become a refusal to work.
    expect(manifest.intent).toBeTruthy();
  });

  it("the classifier does reach the provider when there is budget", async () => {
    config.sessionBudget = 10;
    spend(1.5);

    await classifyIntent({
      newMessage: "unique message for the budget-available case",
      sessionSummary: null,
      recentMessages: [],
      availableTools: [{ type: "function", function: { name: "read_file", description: "read" } }],
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("FLINT_NO_CLASSIFIER", () => {
  // A/B switch: no classifier call, built-in tools, no assessment gate.
  // And the MCP tools while there are few of them (MCP_INLINE_MAX): hidden,
  // a connected Screenbox looked absent to the agent (2026-10-02).
  it("skips the provider and hands over the built-in tools and a few MCP tools", async () => {
    config.sessionBudget = 10;
    process.env.FLINT_NO_CLASSIFIER = "1";
    try {
      const manifest = await classifyIntent({
        newMessage: "delete the duplicate files in this folder",
        sessionSummary: null,
        recentMessages: [],
        availableTools: [
          { type: "function", function: { name: "read_file", description: "read" } },
          { type: "function", function: { name: "delete_file", description: "delete" } },
          { type: "function", function: { name: "mcp_screenbox_desktop_click", description: "click" } },
        ],
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(manifest.assessment).toBe("normal");
      expect(manifest.tools).toEqual(["read_file", "delete_file", "mcp_screenbox_desktop_click"]);
    } finally {
      delete process.env.FLINT_NO_CLASSIFIER;
    }
  });
});
