// Regression test for the coverage gap: no existing test exercises agent.js:640
// (gitStatusCheck called with config.workdir). The mocks in no-change-loop.test.js
// and agent-loop.test.js mock config WITHOUT a workdir key (→ falls through to
// process.cwd() identically) or set it to process.cwd() itself. Reverting
// agent.js:640 to process.cwd() would pass every current test. This test pins
// the contract: when config.workdir is set to a directory distinct from
// process.cwd(), gitStatusCheck must receive that directory.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMockStore } from "../helpers/mock-store.js";
import { mkdirSync, rmSync } from "node:fs";

// Hoisted workdir — must be created in vi.hoisted because vi.mock factories
// run before regular module-level code. We use a path that exists and is
// distinct from process.cwd(). The integration config sets an isolated cwd,
// so /tmp always works here and is guaranteed different from process.cwd().
const workdir = vi.hoisted(() => ({
  path: "/tmp/flint-workdir-git-status-test",
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

let INTENT = { intent: "complex_multi", tools: [], max_steps: 30, changes: "maybe", fallback: false };
vi.mock("../../src/agent/intent.js", () => ({
  classifyIntent: async () => INTENT,
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

// Hoisted spy — vi.mock is hoisted before imports, so the spy ref must be hoisted
const gitStatusSpy = vi.hoisted(() => vi.fn(() => ({ isRepo: true, clean: true })));
vi.mock("../../src/agent/git-status.js", async (importOriginal) => ({
  ...await importOriginal(),
  gitStatusCheck: gitStatusSpy,
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
const say = (content) => ({
  ok: true,
  body: sse([{ id: "gen", choices: [{ delta: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }]),
});
const callTool = (name, args, id = "c1") => ({
  ok: true,
  body: sse([{ id: "gen", choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }]),
});

describe("agent.js passes config.workdir to gitStatusCheck", () => {
  let store;
  let originalFetch;

beforeEach(() => {
    mkdirSync(workdir.path, { recursive: true });
    gitStatusSpy.mockClear();
    store = createMockStore();
    originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls++;
      if (calls === 1) return callTool("run_command", { command: "node -e \"0\"" });
      return say("Done.");
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    vi.resetModules();
    rmSync(workdir.path, { recursive: true, force: true });
  });

  it("calls gitStatusCheck with config.workdir, not process.cwd()", async () => {
    const { initRegistry } = await import("../../src/tools/registry.js");
    const { runAgent } = await import("../../src/agent/agent.js");
    initRegistry(store);
    const messages = [
      { role: "system", content: "You are helpful" },
      { role: "user", content: "List the directory" },
    ];

    await runAgent(messages, {}, { sessionId: "test" });

    expect(gitStatusSpy).toHaveBeenCalled();
    const calledArg = gitStatusSpy.mock.calls[0][0];
    expect(calledArg).toBe(workdir.path);
    expect(calledArg).not.toBe(process.cwd());
  });
});
