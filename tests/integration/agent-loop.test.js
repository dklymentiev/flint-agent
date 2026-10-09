import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTmpDir } from "../helpers/tmp-dir.js";
import { createMockStore } from "../helpers/mock-store.js";
import fs from "node:fs";
import path from "node:path";
import { createStdioSession } from "../../src/stdio/session.js";

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
  it("a busy stdio turn shows text, accepts a steer, and injects it before the next model call", async () => {
    const file = path.join(tmp.path, "data.txt");
    fs.writeFileSync(file, "fixture", "utf8");
    const out = [];
    const encoder = new TextEncoder();
    let releaseFirst;
    let calls = 0;
    globalThis.fetch = vi.fn(async (_url, options) => {
      calls++;
      if (calls === 1) {
        return { ok: true, body: new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode('data: ' + JSON.stringify({ id: "g1", choices: [{ delta: { content: "Working " } }] }) + '\n\n'));
            releaseFirst = () => {
              controller.enqueue(encoder.encode('data: ' + JSON.stringify({ id: "g1", choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read_file", arguments: JSON.stringify({ path: file }) } }] } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }) + '\n\n'));
              controller.enqueue(encoder.encode('data: [DONE]\n\n'));
              controller.close();
            };
          },
        }) };
      }
      const sent = JSON.parse(options.body);
      expect(sent.messages.some((m) => m.role === "user" && String(m.content).includes("use the other file"))).toBe(true);
      return { ok: true, body: buildSSEStream([
        { id: "g2", choices: [{ delta: { content: "Changed course" } }], usage: { prompt_tokens: 20, completion_tokens: 4 } },
      ]) };
    });
    const { initRegistry } = await import("../../src/tools/registry.js");
    const { runAgent } = await import("../../src/agent/agent.js");
    initRegistry(store);
    const session = createStdioSession({
      write: (e) => out.push(e), sessionId: "s1", model: "test-model",
      run: (content, { observer, signal }) => runAgent([
        { role: "system", content: "You are helpful" }, { role: "user", content },
      ], {
        signal,
        onToken: observer.onToken,
        onStreamEnd: observer.onStreamEnd,
        onCheckQueue: observer.onCheckQueue,
        onApiCall: observer.onApiCall,
        onApiResponse: (_n, reply, usage) => observer.onReply(reply, usage),
        onToolResult: (name, result, denied) => observer.onToolResult(name, result, denied),
      }),
    });
    session.line(JSON.stringify({ type: "user", message: { content: "Read the file" } }));
    for (let i = 0; i < 100 && !out.some((e) => e.type === "text_delta"); i++) await new Promise((r) => setTimeout(r, 5));
    expect(out.some((e) => e.type === "text_delta" && e.delta.includes("Working"))).toBe(true);
    expect(out.some((e) => e.type === "result")).toBe(false);
    session.line(JSON.stringify({ type: "control_request", request_id: "steer-1", request: { subtype: "steer", text: "use the other file" } }));
    expect(out.some((e) => e.type === "control_response" && e.response.response.status === "accepted")).toBe(true);
    releaseFirst();
    for (let i = 0; i < 100 && !out.some((e) => e.type === "result"); i++) await new Promise((r) => setTimeout(r, 5));
    expect(calls).toBe(2);
    expect(out.some((e) => e.type === "steer_status" && e.status === "delivered")).toBe(true);
    expect(out.at(-1)).toMatchObject({ type: "result", result: "Changed course" });
  });

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
      onToolStart: (name, args, info) => toolCalls.push({ name, args, startId: info?.id }),
      onToolResult: (name, result, denied, opts) => toolCalls.push({ name, result, resultId: opts?.id }),
    });

    expect(result.text).toBe("The file says: file content here");
    expect(toolCalls.some((t) => t.name === "read_file")).toBe(true);
    // Messages should contain tool result
    const toolMsg = messages.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    expect(toolMsg.content).toContain("file content here");
    // Both callbacks name the call they belong to, so a listener can tell two
    // calls of one tool apart (the stdio event stream keys its timings by it).
    expect(toolMsg.tool_call_id).toBeTruthy();
    expect(toolCalls.find((t) => "startId" in t).startId).toBe(toolMsg.tool_call_id);
    expect(toolCalls.find((t) => "resultId" in t).resultId).toBe(toolMsg.tool_call_id);
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
