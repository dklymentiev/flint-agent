// Two gates must not demand opposite things.
//
// On 2026-09-26 the classifier marked "delete the duplicate files in this
// folder" as dangerous, so the assessment gate took every tool away and asked
// for a text answer. The lookup gate then demanded a list_directory call, three
// times, from a model that had no tools. Three calls, nothing done.

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

vi.mock("../../src/agent/intent.js", () => ({
  classifyIntent: async () => ({
    intent: "file_manage",
    tools: ["list_directory", "delete_file"],
    max_steps: 6,
    assessment: "dangerous",
    requires_prior_tool_call: ["list_directory"],
    fallback: false,
  }),
  filterToolsByManifest: (defs) => defs,
  formatIntentHint: () => "",
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

function sse(chunks) {
  const text = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) { controller.close(); return; }
      controller.enqueue(bytes.slice(offset, offset + 256));
      offset += 256;
    },
  });
}

let originalFetch;
beforeEach(() => { originalFetch = globalThis.fetch; });
afterEach(() => { globalThis.fetch = originalFetch; });

describe("a request the assessment gate marked dangerous", () => {
  it("is answered in one call, without the lookup gate asking for a tool it took away", async () => {
    const answer = "This deletes files. Say yes and I will remove the 4 duplicate copies.";
    const payloads = [];
    globalThis.fetch = vi.fn(async (url, init) => {
      payloads.push(JSON.parse(init.body));
      return {
        ok: true,
        body: sse([{ id: "gen-1", choices: [{ delta: { content: answer } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }]),
      };
    });

    const { initRegistry } = await import("../../src/tools/registry.js");
    const { runAgent } = await import("../../src/agent/agent.js");
    initRegistry(createMockStore());

    const messages = [
      { role: "system", content: "You are helpful" },
      { role: "user", content: "Delete the duplicate files in my downloads folder." },
    ];
    const result = await runAgent(messages, {});

    expect(payloads.length).toBe(1);
    expect(result.text).toContain("duplicate");
    expect(messages.some((m) => typeof m.content === "string" && m.content.includes("[VERIFY FIRST]"))).toBe(false);
  }, 30000);
});
