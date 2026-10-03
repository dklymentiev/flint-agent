// What was already sent must not change underneath the provider.
//
// The prompt cache is a prefix cache. Proven against the real provider on
// 2026-09-21, the same 7600-token request three times:
//
//     call 1   prompt 7600   cached 0      $0.003803
//     call 2   prompt 7600   cached 4076   $0.001969
//     call 3   prompt 7600   cached 4076   $0.001969
//
// So caching works and halves the price of a repeated prefix. Flint reads back
// about five per cent across a run because its payloads do not repeat: of 64
// consecutive calls inside a turn on the measured run, 24 did not extend the
// previous payload, they rewrote it, and 11 per cent of all message positions
// changed content after having been sent.
//
// The cause is not deep compression, which is already behind a token
// threshold and rarely fires. It is the eager pass that replaces every tool
// result over 500 characters from previous iterations with a one-line summary
// on every iteration, whether or not the context is anywhere near full.
//
// The check is about the shape of what is sent, never about wording: each
// payload must begin with the payload before it.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMockStore } from "../helpers/mock-store.js";
import { createTmpDir } from "../helpers/tmp-dir.js";

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
  classifyIntent: async () => ({ intent: "complex_multi", tools: [], max_steps: 30, changes: "maybe", fallback: false }),
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

const say = (content) => ({
  ok: true,
  body: sse([{ id: "gen", choices: [{ delta: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }]),
});

const callTool = (name, args, id) => ({
  ok: true,
  body: sse([{
    id: "gen",
    choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] } }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  }]),
});

let tmp, originalFetch, store;

beforeEach(() => {
  tmp = createTmpDir();
  originalFetch = globalThis.fetch;
  store = createMockStore();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  tmp.cleanup();
});

describe("a payload extends the one before it", () => {
  it("does not rewrite a tool result it has already sent, on a turn with room to spare", async () => {
    // Four reads of a file comfortably over the 500-character eager-summary
    // line, in a turn whose context stays tiny. Nothing here is under memory
    // pressure, so nothing has a reason to be rewritten.
    const big = "x".repeat(4000);
    const file = `${tmp.path}/big.txt`;
    const { writeFileSync } = await import("node:fs");
    writeFileSync(file, big);

    const payloads = [];
    let calls = 0;
    globalThis.fetch = vi.fn(async (_url, opts) => {
      const body = JSON.parse(opts.body);
      // Only the agent loop's own calls carry a tool list. The out-of-band
      // outcome question is a separate request with a system prompt of
      // its own, and comparing it against the conversation would measure
      // nothing.
      if (body.tools !== undefined) payloads.push(body.messages.map((m) => JSON.stringify(m)));
      calls++;
      if (calls <= 4) return callTool("read_file", { path: file }, `c${calls}`);
      return say("Read them all.");
    });

    const { initRegistry } = await import("../../src/tools/registry.js");
    const { runAgent } = await import("../../src/agent/agent.js");
    initRegistry(store);
    await runAgent([
      { role: "system", content: "You are helpful" },
      { role: "user", content: "Read that file a few times" },
    ], {});

    const rewritten = [];
    for (let i = 1; i < payloads.length; i++) {
      const prev = payloads[i - 1];
      const cur = payloads[i];
      let common = 0;
      while (common < Math.min(prev.length, cur.length) && prev[common] === cur[common]) common++;
      if (common < prev.length) {
        rewritten.push({ call: i + 1, keptOf: `${common}/${prev.length}`, changed: JSON.parse(cur[common] || "{}").role });
      }
    }

    expect(rewritten).toEqual([]);
  }, 30000);
});
