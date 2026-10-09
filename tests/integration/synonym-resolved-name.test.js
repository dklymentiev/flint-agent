// A tool called by a synonym (bash) runs as the real tool (run_command), and
// everything downstream of the permission layer must see the real name.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMockStore } from "../helpers/mock-store.js";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

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

describe("agent loop uses the resolved tool name", () => {
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
      if (calls === 1) return callTool("bash", { command: "node -e \"0\"" });
      return say("Done.");
    });
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    vi.resetModules();
    rmSync(workdir.path, { recursive: true, force: true });
  });

  it("reports run_command to onToolResult, records it in the history, and shows the announcement", async () => {
    const { initRegistry } = await import("../../src/tools/registry.js");
    const { resetSynonymAnnouncements } = await import("../../src/tools/permissions.js");
    const { runAgent } = await import("../../src/agent/agent.js");
    initRegistry(store);
    resetSynonymAnnouncements();
    const seen = [];
    const messages = [
      { role: "system", content: "You are helpful" },
      { role: "user", content: "run it" },
    ];
    await runAgent(messages, { onToolResult: (n, text) => seen.push([n, String(text)]) }, { sessionId: "test" });
    expect(seen.map((x) => x[0])).toEqual(["run_command"]);
    const toolMsg = messages.find((m) => m.role === "tool");
    expect(toolMsg._toolName).toBe("run_command");
    expect(toolMsg.content).toContain("bash is an alias for run_command");
  });

  it("counts the synonym as an executing call", async () => {
    const { initRegistry } = await import("../../src/tools/registry.js");
    const { runAgent } = await import("../../src/agent/agent.js");
    initRegistry(store);
    const messages = [
      { role: "system", content: "You are helpful" },
      { role: "user", content: "run it" },
    ];
    const r = await runAgent(messages, {}, { sessionId: "test" });
    // bash is a mutating call once resolved: the clean repo makes it a gap
    expect(r.repoClaimGap).toBe(true);
  });

  // "Once per session" is decided in permissions.js from the session id it is
  // given, and the unit test hands it one directly. Whether the agent loop
  // hands it one was not checked: without it every session shares the key ""
  // and the second session's model is never told what bash is.
  it("tells the model about the alias again in a second session", async () => {
    const { initRegistry } = await import("../../src/tools/registry.js");
    const { resetSynonymAnnouncements } = await import("../../src/tools/permissions.js");
    const { runAgent } = await import("../../src/agent/agent.js");
    initRegistry(store);
    resetSynonymAnnouncements();
    const toolTextOf = async (sessionId) => {
      let calls = 0;
      globalThis.fetch = vi.fn(async () => {
        calls++;
        if (calls === 1) return callTool("bash", { command: "node -e \"0\"" });
        return say("Done.");
      });
      const messages = [
        { role: "system", content: "You are helpful" },
        { role: "user", content: "run it" },
      ];
      await runAgent(messages, {}, { sessionId });
      return String(messages.find((m) => m.role === "tool").content);
    };
    expect(await toolTextOf("session-one")).toContain("bash is an alias for run_command");
    expect(await toolTextOf("session-one"), "repeated within one session").not.toContain("bash is an alias for run_command");
    expect(await toolTextOf("session-two"), "a new session was not told").toContain("bash is an alias for run_command");
  });
});
