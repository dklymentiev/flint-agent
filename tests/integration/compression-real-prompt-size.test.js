// The agent loop hands the provider's real prompt size to the compression
// threshold check.
//
// 37fb77d made compressContext() take `contextTokens` and use the larger of it
// and the chars/4 estimate. tests/unit/agent/compression.test.js proves that
// half. Nothing proved the other half: that the loop actually passes the
// number. With the argument removed from the call in agent.js every test was
// green, and the fix did nothing in a running agent, because a threshold that
// is never given the real size falls back to the estimate it was meant to
// replace.
//
// Here the loop runs for real against a fake provider that reports a prompt
// size; only compressContext is replaced, to see what it is called with.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMockStore } from "../helpers/mock-store.js";
import { mkdirSync, rmSync } from "node:fs";

const workdir = vi.hoisted(() => ({
  path: "/tmp/flint-compression-real-prompt-size-test",
}));

vi.mock("../../src/config.js", () => ({
  config: {
    apiKey: "test-key",
    model: "test-model",
    apiUrl: "https://test.api/v1/chat/completions",
    projectRoot: process.cwd(),
    workdir: workdir.path,
    maxIterations: 50,
  },
}));

vi.mock("../../src/agent/intent.js", () => ({
  classifyIntent: async () => ({ intent: "complex_multi", tools: [], max_steps: 30, changes: "maybe", fallback: false }),
  filterToolsByManifest: (defs) => defs,
  formatIntentHint: () => "",
}));

vi.mock("../../src/agent/modes.js", () => ({ getModeForIntent: () => null, listModes: () => [] }));
vi.mock("../../src/memory/store.js", () => ({
  loadAll: () => [], insertMemory: () => ({ id: 1, content: "", category: "general", importance: 1 }),
  searchMemories: () => [], getMemory: () => null, listRecentMemories: () => [],
  deleteMemory: () => false,
  getMemoryStats: () => ({ total: 0, byCategory: {}, oldest: null, newest: null }),
  clearAllMemories: vi.fn(),
}));
vi.mock("../../src/memory/markdown.js", () => ({ updateMemoryMd: vi.fn(), readMemoryMdHead: () => "" }));
vi.mock("../../src/memory/facts.js", () => ({ extractFacts: () => [], addFact: () => {}, formatForPrompt: () => "" }));
vi.mock("../../src/memory/user-model.js", () => ({ observeUser: () => {}, formatForPrompt: () => "" }));
vi.mock("../../src/memory/patterns.js", () => ({ recordPattern: () => {}, compilePreferences: () => ({}), formatForPrompt: () => "" }));

const compressSpy = vi.hoisted(() => vi.fn(async () => 0));
vi.mock("../../src/agent/compression.js", async (importOriginal) => ({
  ...await importOriginal(),
  compressContext: compressSpy,
}));

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

// What the provider says the first request weighed. Nowhere near chars/4 of
// two short messages, so it cannot be mistaken for the estimate.
const REAL_PROMPT_TOKENS = 54321;

describe("the compression threshold sees the provider's real prompt size", () => {
  let originalFetch;
  beforeEach(() => {
    mkdirSync(workdir.path, { recursive: true });
    compressSpy.mockClear();
    originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls++;
      if (calls === 1) {
        return {
          ok: true,
          body: sse([{
            id: "gen",
            choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "list_directory", arguments: JSON.stringify({ path: workdir.path }) } }] } }],
            usage: { prompt_tokens: REAL_PROMPT_TOKENS, completion_tokens: 5 },
          }]),
        };
      }
      return {
        ok: true,
        body: sse([{ id: "gen", choices: [{ delta: { content: "Done." } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }]),
      };
    });
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    vi.resetModules();
    rmSync(workdir.path, { recursive: true, force: true });
  });

  it("passes the prompt size of the previous call to compressContext before the next one", async () => {
    const { initRegistry } = await import("../../src/tools/registry.js");
    const { runAgent } = await import("../../src/agent/agent.js");
    initRegistry(createMockStore());
    const messages = [
      { role: "system", content: "You are helpful" },
      { role: "user", content: "list it" },
    ];
    await runAgent(messages, {}, { sessionId: "test" });

    expect(globalThis.fetch.mock.calls.length, "the turn must reach a second model call").toBeGreaterThanOrEqual(2);
    const sizesSeen = compressSpy.mock.calls.map((args) => args[4]?.contextTokens);
    expect(
      sizesSeen,
      "compressContext was never given the size the provider reported",
    ).toContain(REAL_PROMPT_TOKENS);
  });
});
