// The turn from the repair benchmark, reproduced: a lot of looking, nothing
// changed, and an answer that reads like finished work.
//
// Criterion 5 asked for a run showing the old behaviour. This is it, driven
// through the real agent loop against a fake provider, so it costs nothing and
// can be re-run. The checks look only at whether anything changed and whether
// it was said, never at the wording.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMockStore } from "../helpers/mock-store.js";
import { createTmpDir } from "../helpers/tmp-dir.js";
import { writeFileSync } from "node:fs";

vi.mock("../../src/config.js", () => ({
  config: {
    apiKey: "test-key",
    model: "test-model",
    apiUrl: "https://test.api/v1/chat/completions",
    projectRoot: process.cwd(),
    maxIterations: 50,
  },
}));

// The class the repair task really landed in, with the field the catalog now
// carries. Classified, not guessed from the wording of the request.
let INTENT = { intent: "complex_multi", tools: [], max_steps: 30, changes: "maybe", fallback: false };
vi.mock("../../src/agent/intent.js", () => ({
  classifyIntent: async () => INTENT,
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

const callTool = (name, args, id = "c1") => ({
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
  INTENT = { intent: "complex_multi", tools: [], max_steps: 30, changes: "maybe", fallback: false };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  tmp.cleanup();
});

async function run(userText) {
  const { initRegistry } = await import("../../src/tools/registry.js");
  const { runAgent } = await import("../../src/agent/agent.js");
  initRegistry(store);
  const messages = [
    { role: "system", content: "You are helpful" },
    { role: "user", content: userText },
  ];
  const result = await runAgent(messages, {});
  return { result, messages };
}

describe("a turn asked to fix something that changed nothing", () => {
  it("does not end like an ordinary answer", async () => {
    // Exactly the shape of the benchmark run: look around, then report a
    // diagnosis. No write is attempted and the answer never claims one.
    const diagnosis = "Based on my investigation I found the two bugs causing the overrun.";
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls++;
      if (calls <= 3) return callTool("list_directory", { path: tmp.path }, `c${calls}`);
      return say(diagnosis);
    });

    const { result } = await run("Find the cause of the budget overrun and fix it");

    // Nothing was written, and the answer is no longer silent about that.
    expect(result.text).toContain(diagnosis);
    expect(result.text.length).toBeGreaterThan(diagnosis.length);
    expect(result.text.toLowerCase()).toMatch(/no file changed/);
  }, 30000);

  it("asks the model which of the three it was, once, and not in the conversation", async () => {
    // Same criterion as before, checked where the out-of-band ask
    // moved it to. The question is now its own small call, so the check is
    // that it happened exactly once and that it never entered the payload the
    // agent is answering from.
    const reason = "I could not find where the cost is added up.";
    let calls = 0;
    let asks = 0;
    const conversation = [];
    globalThis.fetch = vi.fn(async (_url, opts) => {
      const body = JSON.parse(opts.body);
      const isAsk = String(body.messages?.[0]?.content || "").includes("without changing any file");
      if (isAsk) {
        asks++;
        return {
          ok: true,
          json: async () => ({
            choices: [{ message: { content: reason } }],
            usage: { prompt_tokens: 20, completion_tokens: 12 },
          }),
        };
      }
      calls++;
      conversation.push(body.messages.map((m) => m.content).join("\n"));
      if (calls === 1) return callTool("list_directory", { path: tmp.path });
      return say("Looked through the counters.");
    });

    const { result } = await run("Fix the counter");

    expect(asks).toBe(1);
    expect(conversation.some((b) => /without changing any file/.test(b))).toBe(false);
    // Both the answer and the reason reach the operator.
    expect(result.text).toContain("Looked through the counters.");
    expect(result.text).toContain("could not find");
  }, 30000);

  it("keeps the answer when the model answers the outcome question in one sentence", async () => {
    // The tests above hide this: their fake provider returns the same text for
    // every call, so a reply that REPLACES the answer looks identical to one
    // that follows it. A real model does what [OUTCOME] asks, says its one
    // sentence and nothing else, and the answer the operator was waiting for
    // never leaves the loop. Measured on ten readiness probes 2026-09-21:
    // eight turns of ten came back as one sentence about change.
    const diagnosis = "Based on my investigation I found the two bugs causing the overrun.";
    const oneSentence = "The request was not asking for a change.";
    let calls = 0;
    globalThis.fetch = vi.fn(async (_url, opts) => {
      calls++;
      if (calls === 1) return callTool("list_directory", { path: tmp.path });
      const asked = JSON.parse(opts.body).messages
        .some((m) => typeof m.content === "string" && m.content.includes("[OUTCOME]"));
      return say(asked ? oneSentence : diagnosis);
    });

    const { result } = await run("Find the cause of the budget overrun and fix it");

    // The reason may be there as well. The answer may not be missing.
    expect(result.text).toContain(diagnosis);
    expect(result.text.toLowerCase()).toMatch(/no file changed/);
  }, 30000);

  it("leaves a turn that changed something alone", async () => {
    // The class production would give "Write done.txt": the write is the whole
    // request, not a means to something else. The mock said complex_multi,
    // which is wider than the truth, and a mock wider than the original is as
    // misleading as one that is narrower -- it made this read as if a plain
    // file write should be challenged for evidence.
    INTENT = { intent: "file_write", tools: [], max_steps: 5, changes: "yes", fallback: false };
    const target = `${tmp.path}/done.txt`;
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls++;
      if (calls === 1) return callTool("write_file", { path: target, content: "done\n" });
      return say("Wrote the file.");
    });

    const { result } = await run("Write done.txt");

    // Criterion 3: no extra text, and no extra turn spent asking about it.
    expect(result.text).toBe("Wrote the file.");
    expect(calls).toBe(2);
  }, 30000);

  it("leaves a question alone, even though it changed nothing", async () => {
    INTENT = { intent: "file_read", tools: [], max_steps: 3, changes: "no", fallback: false };
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls++;
      if (calls === 1) return callTool("list_directory", { path: tmp.path });
      return say("The directory is empty.");
    });

    const { result } = await run("What is in this directory?");

    expect(result.text).toBe("The directory is empty.");
  }, 30000);

  it("counts a write that did not land as no change, and says where it looked", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls++;
      // A write that cannot land: the target is an existing directory, so the
      // attempt is real and the file is not. Note write_file creates missing
      // parents by itself, so a deep path is NOT a failing write; the first
      // version of this test assumed it was and was wrong. The disk is read,
      // not the tool's reply, so nothing here parses the refusal.
      if (calls === 1) return callTool("write_file", { path: tmp.path, content: "x" }, "c1");
      return say("The write did not go through.");
    });

    const { result } = await run("Fix it");

    expect(result.text.toLowerCase()).toMatch(/no file changed/);
    expect(result.text).toContain(tmp.path);
  }, 30000);

  it("sees a file whoever wrote it, not only a file tool", async () => {
    // In a benchmark run, ffmpeg through run_command made the file the task asked
    // for, and the answer still ended "[Nothing was changed on disk]". Here a
    // writer outside the tool set makes it while the turn is running.
    const target = `${tmp.path}/made.txt`;
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls++;
      if (calls === 1) return callTool("list_directory", { path: tmp.path });
      writeFileSync(target, "x");
      return say("Made the file.");
    });

    const { result } = await run("Make made.txt");

    expect(result.text.toLowerCase()).not.toMatch(/no file changed|nothing was changed/);
  }, 30000);
});
