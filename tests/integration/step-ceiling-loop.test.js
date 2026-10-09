// What the model is actually told as its turn runs out of steps.
//
// The unit tests next to this one check the arithmetic. This one checks that
// the loop feeds that arithmetic the right ceiling, which is where the defect
// lived: the cut-off used the intent class's ceiling and the warnings used the
// global one, so on a class capped below the global limit the model was told a
// number that was not true, or nothing at all, and then the turn ended.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMockStore } from "../helpers/mock-store.js";
import { createTmpDir } from "../helpers/tmp-dir.js";

const GLOBAL_MAX = 50;
const INTENT_MAX = 6; // what the classifier asks for, well below the global limit

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
    intent: "complex_multi",
    tools: [],
    max_steps: 6,
    fallback: false,
  }),
  filterToolsByManifest: (defs) => defs,
  formatIntentHint: () => "",
}));

vi.mock("../../src/agent/modes.js", () => ({
  getModeForIntent: () => null,
  listModes: () => [],
}));
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

describe("a turn running out of steps, inside the real loop", () => {
  /** Keep calling a tool forever, so only the ceiling can end the turn. */
  function alwaysCallsATool(dir) {
    return vi.fn(async () => ({
      ok: true,
      body: sse([{
        id: "gen-1",
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: `call_${Math.random().toString(36).slice(2, 8)}`,
              function: { name: "list_directory", arguments: JSON.stringify({ path: dir }) },
            }],
          },
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }]),
    }));
  }

  it("runs to the global ceiling whatever the classifier guessed, and warns against that ceiling", async () => {
    // The classifier's max_steps no longer ends the turn. It is a guess
    // about the task and it is not stable: the same repair prompt got 16 steps
    // in one run and 30 in the next. One ceiling decides, and the one warning
    // the model gets counts against it.
    const fetchMock = alwaysCallsATool(tmp.path);
    const payloads = [];
    globalThis.fetch = vi.fn(async (url, init) => {
      payloads.push(JSON.parse(init.body));
      return fetchMock(url, init);
    });

    const { initRegistry } = await import("../../src/tools/registry.js");
    const { runAgent } = await import("../../src/agent/agent.js");
    initRegistry(store);

    const messages = [
      { role: "system", content: "You are helpful" },
      { role: "user", content: "Do a long job" },
    ];
    const result = await runAgent(messages, {});

    expect(result.stop_reason).toBe("budget");
    // Structured field alongside the text note.
    expect(result.truncated_at).toEqual({
      type: "max_iterations",
      limit: GLOBAL_MAX,
      used: payloads.length,
    });
    expect(payloads.length).toBeGreaterThan(INTENT_MAX);
    expect(payloads.length).toBeGreaterThanOrEqual(GLOBAL_MAX);

    // The warning rides on the payload, not in the conversation.
    const warnings = payloads
      .flatMap((p) => p.messages)
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .filter((c) => c.includes("[STEPS:"));
    expect(warnings.length).toBeGreaterThan(0);
    for (const w of new Set(warnings)) {
      expect(w).toContain(`of ${GLOBAL_MAX} used`);
    }
    expect(messages.some((m) => typeof m.content === "string" && m.content.includes("[STEPS:"))).toBe(false);
  }, 60000);

  it("tells the operator which files it left half-finished", async () => {
    const target = `${tmp.path}/half-written.js`;
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls++;
      // First an edit, then read the directory forever until the ceiling ends
      // the turn: the file is on disk and the work around it is not finished.
      const call = calls === 1
        ? { name: "write_file", arguments: JSON.stringify({ path: target, content: "const LIMIT = 30;\n" }) }
        : { name: "list_directory", arguments: JSON.stringify({ path: tmp.path }) };
      return {
        ok: true,
        body: sse([{
          id: "gen-1",
          choices: [{ delta: { tool_calls: [{ index: 0, id: `call_${calls}`, function: call }] } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }]),
      };
    });

    const { initRegistry } = await import("../../src/tools/registry.js");
    const { runAgent } = await import("../../src/agent/agent.js");
    initRegistry(store);

    const messages = [
      { role: "system", content: "You are helpful" },
      { role: "user", content: "Add a limit constant and use it everywhere" },
    ];
    const result = await runAgent(messages, {});

    // Whatever else it says, the file it touched is named.
    expect(result.text).toContain("half-written.js");
    expect(result.text).toMatch(/half-finished|cut short/i);

    // Structured field: the turn was cut by the step limit. `used` counts the
    // real number of provider calls, which includes the summary turn the loop
    // spends after hitting the ceiling — so it is effectiveMaxIter + 1, not
    // exactly effectiveMaxIter. The first test asserts against its own
    // payload count for the same reason.
    expect(result.truncated_at).toEqual({
      type: "max_iterations",
      limit: 50,
      used: 51,
    });
    // stop_reason is still "budget" so existing callers keep working.
    expect(result.stop_reason).toBe("budget");
  }, 30000);
});
