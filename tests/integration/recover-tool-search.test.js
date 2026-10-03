// After a failed tool call in search mode, the RECOVER nudge says that other
// tools exist and tool_search finds them, without naming one. Behind
// FLINT_RECOVER_TOOL_SEARCH=1 so the A/B changes one variable.

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

// One failing call, then a plain answer. Returns the nudge riding on the
// second main-loop payload (the one that follows the failure).
async function nudgeAfterFailure() {
  const payloads = [];
  let n = 0;
  globalThis.fetch = vi.fn(async (url, init) => {
    const body = JSON.parse(init.body);
    payloads.push(body);
    if (!(body.tools || []).length) return { ok: true, body: sse({ content: "ok" }) };
    n++;
    const delta = n === 1
      ? { tool_calls: [{ index: 0, id: "c1", function: { name: "read_file", arguments: JSON.stringify({ path: "no-such-file-5014.txt" }) } }] }
      : { content: "done" };
    return { ok: true, body: sse(delta) };
  });

  vi.resetModules();
  const { initRegistry } = await import("../../src/tools/registry.js");
  const { runAgent } = await import("../../src/agent/agent.js");
  initRegistry(createMockStore());

  await runAgent([
    { role: "system", content: "You are helpful" },
    { role: "user", content: "Read no-such-file-5014.txt." },
  ], {});

  const loop = payloads.filter((p) => (p.tools || []).length > 0);
  const last = loop[1].messages[loop[1].messages.length - 1];
  return last.role === "system" ? last.content : "";
}

let originalFetch;
beforeEach(() => { originalFetch = globalThis.fetch; });
afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.FLINT_TOOL_MODE;
  delete process.env.FLINT_RECOVER_TOOL_SEARCH;
});

describe("RECOVER points at tool_search", () => {
  it("search mode, switch on: the nudge mentions tool_search", async () => {
    process.env.FLINT_TOOL_MODE = "search";
    process.env.FLINT_RECOVER_TOOL_SEARCH = "1";
    const nudge = await nudgeAfterFailure();
    expect(nudge).toContain("[RECOVER]");
    expect(nudge).toContain("tool_search");
  }, 30000);

  it("search mode, switch off: plain RECOVER only", async () => {
    process.env.FLINT_TOOL_MODE = "search";
    const nudge = await nudgeAfterFailure();
    expect(nudge).toContain("[RECOVER]");
    expect(nudge).not.toContain("tool_search");
  }, 30000);

  // tool_search is registered in every mode since 2026-10-02 (MCP tools past
  // the inline limit are offered through it), so it is there to point at.
  it("switch on without search mode: tool_search is in hand, so the nudge names it", async () => {
    process.env.FLINT_RECOVER_TOOL_SEARCH = "1";
    const nudge = await nudgeAfterFailure();
    expect(nudge).toContain("[RECOVER]");
    expect(nudge).toContain("tool_search");
  }, 30000);
});
