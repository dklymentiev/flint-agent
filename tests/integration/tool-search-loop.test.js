// In search mode a tool found by tool_search is in the payload of the very
// next call, and the classifier is never asked.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMockStore } from "../helpers/mock-store.js";

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

describe("search mode", () => {
  it("puts a found tool in the next payload without calling the classifier", async () => {
    const payloads = [];
    let n = 0;
    globalThis.fetch = vi.fn(async (url, init) => {
      const body = JSON.parse(init.body);
      payloads.push(body);
      n++;
      const delta = n === 1
        ? { tool_calls: [{ index: 0, id: "c1", function: { name: "tool_search", arguments: JSON.stringify({ query: "screenshot of the remote desktop" }) } }] }
        : { content: "done" };
      return { ok: true, body: sse(delta) };
    });

    const { initRegistry, registerMcpTools } = await import("../../src/tools/registry.js");
    const { runAgent } = await import("../../src/agent/agent.js");
    initRegistry(createMockStore());
    registerMcpTools(
      [{ type: "function", function: { name: "mcp_screenbox_desktop_screenshot", description: "Take a screenshot of a virtual desktop", parameters: { type: "object", properties: {} } } }],
      { mcp_screenbox_desktop_screenshot: async () => "ok" },
      [],
    );

    const messages = [
      { role: "system", content: "You are helpful" },
      { role: "user", content: "Take a screenshot of the remote desktop." },
    ];
    await runAgent(messages, {});

    const names = (p) => (p.tools || []).map((t) => t.function?.name);
    // The main loop's calls are the ones carrying tools. The classifier would
    // be one without tools BEFORE the first of them; the outcome question after
    // a turn that changed nothing is one without tools after the last.
    const first = payloads.findIndex((p) => (p.tools || []).length > 0);
    expect(first).toBe(0);
    const loop = payloads.filter((p) => (p.tools || []).length > 0);
    expect(loop.length).toBe(2);
    expect(names(loop[0])).toContain("tool_search");
    expect(names(loop[0])).not.toContain("mcp_screenbox_desktop_screenshot");
    expect(names(loop[1])).toContain("mcp_screenbox_desktop_screenshot");
    // Appended, not re-sorted: everything the first call had comes first.
    expect(names(loop[1]).slice(0, names(loop[0]).length)).toEqual(names(loop[0]));
  }, 30000);
});
