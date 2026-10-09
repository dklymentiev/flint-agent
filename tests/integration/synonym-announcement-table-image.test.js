// The alias notice reaches the model when the tool's result is a table or an
// image.
//
// A text result carries the notice in its text. A table or an image has no
// text field, so permissions.js hangs the notice on the result as
// `_announcement` and the agent loop is the one that has to put it in front
// of what the model reads. The unit test checks that `_announcement` is set;
// nothing checked that the loop uses it, and with both uses removed from
// agent.js every test stayed green.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMockStore } from "../helpers/mock-store.js";
import { mkdirSync, rmSync } from "node:fs";

const workdir = vi.hoisted(() => ({
  path: "/tmp/flint-synonym-table-image-test",
}));

vi.mock("../../src/config.js", () => ({
  config: {
    apiKey: "test-key",
    model: "test-model",
    apiUrl: "https://test.api/v1/chat/completions",
    projectRoot: process.cwd(),
    workdir: workdir.path,
    sessionsDir: workdir.path,
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

// The real registry, with the one call that runs a tool replaced: what the
// tool "returned" is the only thing a test here chooses.
const toolResult = vi.hoisted(() => ({ value: null }));
vi.mock("../../src/tools/registry.js", async (importOriginal) => ({
  ...await importOriginal(),
  executeTool: async () => toolResult.value,
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

const NOTICE = "ls is an alias for list_directory";

describe("the alias notice on a result that has no text", () => {
  let originalFetch;

  // One turn: the model calls `ls` (a synonym of list_directory), the tool
  // answers with `result`, the model says Done.
  async function turnWith(result, sessionId) {
    toolResult.value = result;
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls++;
      if (calls === 1) return callTool("ls", { path: workdir.path });
      return say("Done.");
    });
    const { initRegistry } = await import("../../src/tools/registry.js");
    const { resetSynonymAnnouncements } = await import("../../src/tools/permissions.js");
    const { runAgent } = await import("../../src/agent/agent.js");
    initRegistry(createMockStore());
    resetSynonymAnnouncements();
    const shown = [];
    const messages = [
      { role: "system", content: "You are helpful" },
      { role: "user", content: "list it" },
    ];
    await runAgent(messages, { onToolResult: (n, payload) => shown.push([n, payload]) }, { sessionId });
    return { messages, shown };
  }

  beforeEach(() => {
    mkdirSync(workdir.path, { recursive: true });
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    vi.resetModules();
    rmSync(workdir.path, { recursive: true, force: true });
  });

  it("a table: the text the model gets starts with the notice", async () => {
    const { messages } = await turnWith(
      { _table: true, title: "Files", columns: ["name"], rows: [["a.txt"]] },
      "table-session",
    );
    const toolMsg = messages.find((m) => m.role === "tool");
    expect(toolMsg, "the table call left no tool message").toBeDefined();
    expect(toolMsg._toolName).toBe("list_directory");
    expect(String(toolMsg.content)).toContain("Files");
    expect(String(toolMsg.content), "the model was not told what ls is").toContain(NOTICE);
  });

  it("an image: the caption shown for it starts with the notice", async () => {
    const { shown } = await turnWith(
      { _image: true, data: "AAAA", format: "png", text: "a screenshot" },
      "image-session",
    );
    const captions = shown.filter(([n]) => n === "list_directory").map(([, payload]) => String(payload));
    expect(captions.length, "the image result was never shown").toBeGreaterThan(0);
    expect(captions.join("\n")).toContain("a screenshot");
    expect(captions.join("\n"), "the caption does not carry the notice").toContain(NOTICE);
  });
});
