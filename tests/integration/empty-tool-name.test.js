// A tool call the model streams with an empty name must not reach the
// history. box-4c W-search-002 (2026-09-28): mimo sent tool_calls[1] with
// name "", Flint answered it with 'unknown tool ""' and kept it, and every
// provider then refused the whole history with 400 "tool_calls[1].function
// .name must be a non-empty string". The turn died on a slip it could have
// shrugged off. The mock provider here refuses the same way.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../src/config.js", () => ({
  config: {
    apiKey: "test-key",
    model: "test-model",
    apiUrl: "https://test.api/v1/chat/completions",
    projectRoot: process.cwd(),
    maxIterations: 50,
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

function sse(delta) {
  const text = `data: ${JSON.stringify({ id: "gen-1", choices: [{ delta }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`;
  const bytes = new TextEncoder().encode(text);
  let done = false;
  return new ReadableStream({ pull(c) { if (done) { c.close(); return; } c.enqueue(bytes); done = true; } });
}

let originalFetch;
beforeEach(() => { originalFetch = globalThis.fetch; process.env.FLINT_TOOL_MODE = "search"; });
afterEach(() => { globalThis.fetch = originalFetch; delete process.env.FLINT_TOOL_MODE; });

describe("a tool call with an empty name", () => {
  it("is dropped, the valid call beside it runs, and the turn goes on", async () => {
    let n = 0;
    globalThis.fetch = vi.fn(async (url, init) => {
      const body = JSON.parse(init.body);
      // What every provider did on 2026-09-28.
      const bad = (body.messages || []).some((m) => (m.tool_calls || []).some((tc) => !tc.function?.name));
      if (bad) {
        return { ok: false, status: 400, text: async () => '{"error":{"message":"tool_calls[1].function.name must be a non-empty string (got empty string)"}}', json: async () => ({}) };
      }
      n++;
      const delta = n === 1
        ? { tool_calls: [
            { index: 0, id: "c1", function: { name: "think", arguments: JSON.stringify({ thought: "search first" }) } },
            { index: 1, id: "c2", function: { name: "", arguments: "{}" } },
          ] }
        : { content: "done" };
      return { ok: true, body: sse(delta) };
    });

    const { initRegistry } = await import("../../src/tools/registry.js");
    const { runAgent } = await import("../../src/agent/agent.js");
    const { createMockStore } = await import("../helpers/mock-store.js");
    initRegistry(createMockStore());

    const messages = [
      { role: "system", content: "You are helpful" },
      { role: "user", content: "Find the license." },
    ];
    const res = await runAgent(messages, {});

    // The answer, with the change-tracker's note after it; not an API error.
    expect(res.text.startsWith("done")).toBe(true);
    const calls = messages.flatMap((m) => m.tool_calls || []);
    expect(calls.map((tc) => tc.function.name)).toEqual(["think"]);
    expect(messages.some((m) => m.role === "tool" && m._toolName === "think")).toBe(true);
  }, 30000);
});
