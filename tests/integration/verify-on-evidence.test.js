// [VERIFY] must fire on evidence, not on vocabulary.
//
// Found on the repair benchmark, 2026-09-21, task auto-budget. The agent made
// twenty-two tool calls, exactly one of them a command (a `find` for file
// names, at the very start), never ran a test, never reproduced the symptom
// before or after, and finished with:
//
//     "Verifying the fix:"  ->  search_in_files(pattern=\.stats\?\.cost)
//     "No remaining work. Zero occurrences of .stats?.cost remain."
//
// It verified that its own edit had been applied. The gate scored 14 turns
// against a budget of six.
//
// The loop has a guard for exactly this, and it did not fire once, because it
// decides from a word list:
//
//     /\b(completed|successfully|done|finished|saved|created|opened)\b/
//
// The agent wrote "fixed", "applied", "No remaining work". None of those are
// on the list, and the next model will pick different words again.
//
// The facts the loop already holds are what these checks use: which files the
// turn changed, and whether anything was executed after the last change.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMockStore } from "../helpers/mock-store.js";
import { createTmpDir } from "../helpers/tmp-dir.js";
import { existsSync } from "node:fs";

vi.mock("../../src/config.js", async () => ({
  config: {
    apiKey: "test-key",
    model: "test-model",
    apiUrl: "https://test.api/v1/chat/completions",
    projectRoot: process.cwd(),
    maxIterations: 50,
    // Off by default now; these tests are about the gate itself.
    selfVerify: "on",
    // The real shell. Without it run_command threw on Windows before running
    // anything, so "the change was actually run" was never run.
    shell: (await vi.importActual("../../src/config.js")).config.shell,
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

/** The words the agent on the benchmark actually used. None are on the old list. */
const CLAIM_WITHOUT_THE_MAGIC_WORDS =
  "Root cause found and fixed. Fix applied to all four sites. No remaining work.";

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

/** Every payload the agent loop sent, flattened, so a check can ask what it saw. */
function capture(payloads, plan) {
  let call = 0;
  return vi.fn(async (_url, opts) => {
    const body = JSON.parse(opts.body);
    if (body.tools === undefined) {
      // The out-of-band outcome question, not part of the conversation.
      return { ok: true, json: async () => ({ choices: [{ message: { content: "nothing to change" } }], usage: {} }) };
    }
    payloads.push(body.messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n"));
    return plan(++call);
  });
}

const sawVerify = (payloads) => payloads.some((p) => p.includes("[VERIFY]"));

describe("the self-verification gate", () => {
  it("fires on a turn that changed a file and executed nothing, whatever words it used", async () => {
    const target = `${tmp.path}/auto.js`;
    const payloads = [];
    globalThis.fetch = capture(payloads, (call) => {
      if (call === 1) return callTool("write_file", { path: target, content: "totalCost += r?.stats?._cost || 0;\n" }, "c1");
      // Its own idea of verification: look at the text it just wrote.
      if (call === 2) return callTool("search_in_files", { path: tmp.path, pattern: "_cost" }, "c2");
      return say(CLAIM_WITHOUT_THE_MAGIC_WORDS);
    });

    const { initRegistry } = await import("../../src/tools/registry.js");
    const { runAgent } = await import("../../src/agent/agent.js");
    initRegistry(store);
    await runAgent([
      { role: "system", content: "You are helpful" },
      { role: "user", content: "The budget does not stop the run. Fix it." },
    ], {});

    expect(sawVerify(payloads), "a change nobody ran passed without a word").toBe(true);
  }, 30000);

  it("stays silent when the operator turned it off", async () => {
    // The gate was built for weaker models (Gemini Flash) that stop before
    // checking their work. On mimo in a 2026-09-29 benchmark run it fired in 34 of
    // 43 tasks, one extra round each, while a reference agent without such a gate passed
    // as many. So it is the operator's switch: FLINT_SELF_VERIFY=off.
    const { config } = await import("../../src/config.js");
    config.selfVerify = "off";
    const target = `${tmp.path}/auto.js`;
    const payloads = [];
    globalThis.fetch = capture(payloads, (call) => {
      if (call === 1) return callTool("write_file", { path: target, content: "totalCost += r?.stats?._cost || 0;\n" }, "c1");
      return say(CLAIM_WITHOUT_THE_MAGIC_WORDS);
    });
    try {
      const { initRegistry } = await import("../../src/tools/registry.js");
      const { runAgent } = await import("../../src/agent/agent.js");
      initRegistry(store);
      await runAgent([
        { role: "system", content: "You are helpful" },
        { role: "user", content: "The budget does not stop the run. Fix it." },
      ], {});
    } finally {
      config.selfVerify = "on";
    }
    expect(sawVerify(payloads), "asked to verify although the operator turned the gate off").toBe(false);
    expect(payloads.length).toBe(2);
  }, 30000);

  it("does not fire on a turn that changed nothing, however confident it sounds", async () => {
    // Long enough that the old guard's `apiCallCount > 3` is no help: without
    // this the check passed by accident, on turn length rather than on
    // evidence, and would have gone on passing after the gate was broken.
    const payloads = [];
    globalThis.fetch = capture(payloads, (call) => {
      if (call <= 4) return callTool("list_directory", { path: tmp.path }, `c${call}`);
      return say("All done, the task completed successfully and the file was saved.");
    });

    const { initRegistry } = await import("../../src/tools/registry.js");
    const { runAgent } = await import("../../src/agent/agent.js");
    initRegistry(store);
    await runAgent([
      { role: "system", content: "You are helpful" },
      { role: "user", content: "What is in this directory?" },
    ], {});

    // Every magic word from the old list is in that sentence, and none of them
    // is evidence of anything: the turn changed no file.
    expect(sawVerify(payloads), "fired on optimism alone").toBe(false);
  }, 30000);

  it("does not fire when the change was actually run", async () => {
    const target = `${tmp.path}/ok.js`;
    const payloads = [];
    globalThis.fetch = capture(payloads, (call) => {
      if (call === 1) return callTool("write_file", { path: target, content: "console.log('ok')\n" }, "c1");
      if (call === 2) return callTool("run_command", { command: `node "${target}"` }, "c2");
      return say(CLAIM_WITHOUT_THE_MAGIC_WORDS);
    });

    const { initRegistry } = await import("../../src/tools/registry.js");
    const { runAgent } = await import("../../src/agent/agent.js");
    initRegistry(store);
    await runAgent([
      { role: "system", content: "You are helpful" },
      { role: "user", content: "Write ok.js and check it runs" },
    ], {});

    // The change was executed after it was made. That is the evidence the gate
    // is looking for, so it has nothing to ask about.
    expect(sawVerify(payloads), "asked again about a change that was already run").toBe(false);
  }, 30000);

  it("does not fire on a file the command itself made", async () => {
    // In a benchmark run, ffmpeg wrote the MP3, so the file is newer
    // than the start of the run that made it. Compared with the start, that
    // read as "changed after the last run", the gate asked, and the extra
    // turn cost a model call and came back in another language.
    const target = `${tmp.path}/made.txt`.replace(/\\/g, "/");
    const payloads = [];
    globalThis.fetch = capture(payloads, (call) => {
      if (call === 1) return callTool("run_command", { command: `node -e "require('fs').writeFileSync(process.argv[1], 'x')" "${target}"` }, "c1");
      return say(CLAIM_WITHOUT_THE_MAGIC_WORDS);
    });

    const { initRegistry } = await import("../../src/tools/registry.js");
    const { runAgent } = await import("../../src/agent/agent.js");
    initRegistry(store);
    await runAgent([
      { role: "system", content: "You are helpful" },
      { role: "user", content: `Make ${target}` },
    ], {});

    expect(existsSync(target), "the command did not make the file; the test proves nothing").toBe(true);
    expect(sawVerify(payloads), "asked to verify a file its own run produced").toBe(false);
  }, 30000);
});
