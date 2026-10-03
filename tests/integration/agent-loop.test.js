import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTmpDir } from "../helpers/tmp-dir.js";
import { createMockStore } from "../helpers/mock-store.js";
import fs from "node:fs";
import path from "node:path";

// Mock config
vi.mock("../../src/config.js", () => ({
  config: {
    apiKey: "test-key",
    model: "test-model",
    apiUrl: "https://test.api/v1/chat/completions",
    projectRoot: process.cwd(),
  },
}));

// Mock memory modules to avoid filesystem side effects
vi.mock("../../src/memory/store.js", () => ({
  loadAll: () => [],
  insertMemory: () => ({ id: 1, content: "", category: "general", importance: 1, created_at: new Date().toISOString() }),
  searchMemories: () => [],
  getMemory: () => null,
  listRecentMemories: () => [],
  deleteMemory: () => false,
  getMemoryStats: () => ({ total: 0, byCategory: {}, oldest: null, newest: null }),
  clearAllMemories: vi.fn(),
}));

vi.mock("../../src/memory/markdown.js", () => ({
  updateMemoryMd: vi.fn(),
  readMemoryMdHead: () => "",
}));

// Mock intent classifier to avoid extra fetch calls.
//
// `changes` is what the catalog says about a class: whether a request of that
// kind is supposed to end with something different on disk. The three
// tests below ask a question, read a file and think out loud, all of which
// production classifies as read-only, so the mock says so too. Left out, the
// mock claimed the catch-all class and these turns were accounted as changes
// that never happened, which says more about the mock than about the loop.
vi.mock("../../src/agent/intent.js", () => ({
  classifyIntent: async () => ({
    intent: "complex_multi",
    tools: [],
    max_steps: 50,
    changes: "no",
    fallback: true,
  }),
  filterToolsByManifest: (defs) => defs,
  formatIntentHint: () => "",
}));

// Mock modes
vi.mock("../../src/agent/modes.js", () => ({
  getModeForIntent: () => null,
  listModes: () => [],
}));

// Mock memory layers that agent.js imports
vi.mock("../../src/memory/facts.js", () => ({
  extractFacts: () => [],
  addFact: () => {},
  formatForPrompt: () => "",
}));

vi.mock("../../src/memory/user-model.js", () => ({
  observeUser: () => {},
  formatForPrompt: () => "",
}));

vi.mock("../../src/memory/patterns.js", () => ({
  recordPattern: () => {},
  compilePreferences: () => ({}),
  formatForPrompt: () => "",
}));

function buildSSEStream(chunks) {
  const lines = [];
  for (const chunk of chunks) {
    lines.push(`data: ${JSON.stringify(chunk)}\n\n`);
  }
  lines.push("data: [DONE]\n\n");
  const text = lines.join("");
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + 256));
      offset += 256;
    },
  });
}

let tmp;
let originalFetch;
let store;

beforeEach(() => {
  tmp = createTmpDir();
  originalFetch = globalThis.fetch;
  store = createMockStore();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  tmp.cleanup();
});

describe("agent-loop integration", () => {
  it("simple response — no tool calls", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      body: buildSSEStream([
        { id: "gen-1", choices: [{ delta: { content: "Hello user!" } }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
      ]),
    }));

    // Import after mocking
    const { initRegistry } = await import("../../src/tools/registry.js");
    const { runAgent } = await import("../../src/agent/agent.js");
    initRegistry(store);

    const messages = [
      { role: "system", content: "You are helpful" },
      { role: "user", content: "Hi" },
    ];
    const tokens = [];
    const result = await runAgent(messages, {
      onToken: (t) => tokens.push(t),
    });

    expect(result.text).toBe("Hello user!");
    expect(tokens).toContain("Hello user!");
    expect(result.stats.promptTokens).toBe(10);
    expect(result.stats.completionTokens).toBe(5);
  });

  it("with tool call — read_file → final response", async () => {
    // Create a test file for read_file tool
    const testFile = path.join(tmp.path, "data.txt");
    fs.writeFileSync(testFile, "file content here", "utf-8");

    let callCount = 0;
    globalThis.fetch = vi.fn(async () => {
      callCount++;
      if (callCount === 1) {
        // First call: API returns tool_call
        return {
          ok: true,
          body: buildSSEStream([
            {
              id: "gen-1",
              choices: [{
                delta: {
                  tool_calls: [{
                    index: 0,
                    id: "call_1",
                    function: {
                      name: "read_file",
                      arguments: JSON.stringify({ path: testFile }),
                    },
                  }],
                },
              }],
              usage: { prompt_tokens: 20, completion_tokens: 10 },
            },
          ]),
        };
      }
      // Second call: final text response
      return {
        ok: true,
        body: buildSSEStream([
          { id: "gen-2", choices: [{ delta: { content: "The file says: file content here" } }], usage: { prompt_tokens: 30, completion_tokens: 15 } },
        ]),
      };
    });

    const { initRegistry } = await import("../../src/tools/registry.js");
    const { runAgent } = await import("../../src/agent/agent.js");
    initRegistry(store);

    const messages = [
      { role: "system", content: "You are helpful" },
      { role: "user", content: "Read the file" },
    ];
    const toolCalls = [];
    const result = await runAgent(messages, {
      onToolStart: (name, args) => toolCalls.push({ name, args }),
      onToolResult: (name, result) => toolCalls.push({ name, result }),
    });

    expect(result.text).toBe("The file says: file content here");
    expect(toolCalls.some((t) => t.name === "read_file")).toBe(true);
    // Messages should contain tool result
    const toolMsg = messages.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    expect(toolMsg.content).toContain("file content here");
  });

  it("think tool — onThought called", async () => {
    let callCount = 0;
    globalThis.fetch = vi.fn(async () => {
      callCount++;
      if (callCount === 1) {
        return {
          ok: true,
          body: buildSSEStream([
            {
              id: "gen-1",
              choices: [{
                delta: {
                  tool_calls: [{
                    index: 0,
                    id: "call_think",
                    function: {
                      name: "think",
                      arguments: JSON.stringify({ thought: "Let me analyze this" }),
                    },
                  }],
                },
              }],
              usage: { prompt_tokens: 10, completion_tokens: 5 },
            },
          ]),
        };
      }
      return {
        ok: true,
        body: buildSSEStream([
          { id: "gen-2", choices: [{ delta: { content: "After thinking, here is my answer." } }], usage: { prompt_tokens: 15, completion_tokens: 10 } },
        ]),
      };
    });

    const { initRegistry } = await import("../../src/tools/registry.js");
    const { runAgent } = await import("../../src/agent/agent.js");
    initRegistry(store);

    const messages = [{ role: "user", content: "Complex question" }];
    const thoughts = [];
    const result = await runAgent(messages, {
      onThought: (text) => thoughts.push(text),
    });

    expect(thoughts).toContain("Let me analyze this");
    expect(result.text).toContain("After thinking");
  });
});
