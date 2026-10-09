// Claim-vs-repo: a turn is flagged only when a call that can change the
// workspace ran and left no trace. Reads, and work outside the tree, are not
// a claim about the repo.

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

describe("repoClaimGap counts only calls that can change the workspace", () => {
  let store;
  let originalFetch;

  async function turn(toolName, toolArgs) {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls++;
      if (calls === 1) return callTool(toolName, toolArgs);
      return say("Done.");
    });
    const { initRegistry } = await import("../../src/tools/registry.js");
    const { runAgent } = await import("../../src/agent/agent.js");
    initRegistry(store);
    const messages = [
      { role: "system", content: "You are helpful" },
      { role: "user", content: "do it" },
    ];
    return runAgent(messages, {}, { sessionId: "test" });
  }

  beforeEach(() => {
    mkdirSync(workdir.path, { recursive: true });
    gitStatusSpy.mockClear();
    store = createMockStore();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    vi.resetModules();
    rmSync(workdir.path, { recursive: true, force: true });
  });

  it("a read-only turn in a clean repo is not flagged", async () => {
    const r = await turn("list_directory", { path: workdir.path });
    expect(r.repoClaimGap).toBe(false);
  });

  it("a read-only turn does not pay for a git status", async () => {
    await turn("list_directory", { path: workdir.path });
    expect(gitStatusSpy).not.toHaveBeenCalled();
  });

  it("a turn with no tools does not pay for a git status", async () => {
    globalThis.fetch = vi.fn(async () => say("Hello."));
    const { initRegistry } = await import("../../src/tools/registry.js");
    const { runAgent } = await import("../../src/agent/agent.js");
    initRegistry(store);
    await runAgent([{ role: "system", content: "s" }, { role: "user", content: "hi" }], {}, { sessionId: "test" });
    expect(gitStatusSpy).not.toHaveBeenCalled();
  });

  it("a command that changed nothing in a clean repo is still flagged", async () => {
    const r = await turn("run_command", { command: "node -e \"0\"" });
    expect(r.repoClaimGap).toBe(true);
  });

  it("a write outside the work tree is not flagged", async () => {
    const outside = path.join(os.tmpdir(), "flint-claim-outside-" + process.pid + ".txt");
    try {
      const r = await turn("write_file", { path: outside, content: "x" });
      expect(r.repoClaimGap).toBe(false);
    } finally {
      rmSync(outside, { force: true });
    }
  });

  // The same command as "still flagged" above, refused instead of run. A call
  // that never ran changed nothing and claimed nothing, so the clean repo is
  // no gap and no git status is paid for. Without the `!denied` condition
  // every refused command reads as "the agent said it did something and the
  // repo shows nothing".
  it("a command that was refused is not flagged", async () => {
    const perms = await import("../../src/tools/permissions.js");
    perms.setPermission("run_command", "deny");
    try {
      const r = await turn("run_command", { command: "node -e \"0\"" });
      expect(r.repoClaimGap).toBe(false);
      expect(gitStatusSpy).not.toHaveBeenCalled();
    } finally {
      perms.resetPermissionState();
    }
  });
});
