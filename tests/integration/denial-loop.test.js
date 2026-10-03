// A refusal is a decision, not an obstacle. The model used to meet "dangerous
// command blocked" and come straight back with the same command wearing a
// different tail, until the turn ran out of iterations. system.md says not to;
// this test is about the part that does not rely on the model reading it.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMockStore } from "../helpers/mock-store.js";

vi.mock("../../src/config.js", () => ({
  config: {
    apiKey: "test-key",
    model: "test-model",
    apiUrl: "https://test.api/v1/chat/completions",
    projectRoot: process.cwd(),
  },
}));

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

vi.mock("../../src/agent/intent.js", () => ({
  classifyIntent: async () => ({ intent: "complex_multi", tools: [], max_steps: 50, fallback: true }),
  filterToolsByManifest: (defs) => defs,
  formatIntentHint: () => "",
}));

vi.mock("../../src/agent/modes.js", () => ({
  getModeForIntent: () => null,
  listModes: () => [],
}));

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
  const text = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) return controller.close();
      controller.enqueue(bytes.slice(offset, offset + 256));
      offset += 256;
    },
  });
}

let originalFetch;
let store;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  store = createMockStore();
  vi.resetModules();
  // A silent model is now waited out (30 s, then 60 s) rather than stopped on
  // at once, which is the behaviour these two tests below are about. The real
  // pauses would blow the 30 s test timeout, so the growth itself is unit-tested
  // in tests/unit/agent/backoff.test.js and here it is reduced to nothing.
  process.env.AGENT_BACKOFF_MS = "1";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.AGENT_BACKOFF_MS;
});

describe("a tool that keeps being refused ends the turn", () => {
  it("stops after three refusals of the same tool instead of looping", async () => {
    // The observed loop: same blocked command, a different tail each time.
    const variants = [
      'rm -rf ./gaia-tmp && mkdir -p ./gaia-tmp',
      'rm -rf ./gaia-tmp && mkdir -p ./gaia-tmp && ls -d gaia-tmp',
      'rm -rf ./gaia-tmp && mkdir -p ./gaia-tmp && echo "done"',
      'find ./gaia-tmp -type f -delete; rm -rf ./gaia-tmp; mkdir -p ./gaia-tmp',
      'rm -rf ./gaia-tmp || true; mkdir -p ./gaia-tmp',
    ];
    let call = 0;
    globalThis.fetch = vi.fn(async () => {
      const command = variants[Math.min(call, variants.length - 1)];
      call++;
      return {
        ok: true,
        body: buildSSEStream([
          {
            id: `gen-${call}`,
            choices: [{
              delta: {
                tool_calls: [{
                  index: 0,
                  id: `call_${call}`,
                  function: { name: "run_command", arguments: JSON.stringify({ command }) },
                }],
              },
            }],
            usage: { prompt_tokens: 20, completion_tokens: 10 },
          },
        ]),
      };
    });

    const { initRegistry } = await import("../../src/tools/registry.js");
    const perms = await import("../../src/tools/permissions.js");
    const { runAgent } = await import("../../src/agent/agent.js");
    initRegistry(store);

    perms.addBeforeHook((name) =>
      name === "run_command" ? { deny: true, reason: "dangerous command blocked" } : null
    );

    const result = await runAgent(
      [
        { role: "system", content: "You are helpful" },
        { role: "user", content: "reset the gaia-tmp directory" },
      ],
      {},
    );

    expect(result.stop_reason).toBe("denied");
    expect(result.text).toContain("run_command");
    expect(result.text).toMatch(/refused 3 times/);
    // Three attempts, then stop. Without the guard the model keeps being asked
    // and burns every iteration the budget allows.
    expect(call).toBe(3);
  }, 30000);
});

// An early stop used to be returned as text that never reached the
// console or chat.log; the operator saw the last streamed line and a prompt.
// Everything the operator sees goes through onToken, so that is what is
// checked here.
function toolCallReply(call, command) {
  return {
    ok: true,
    body: buildSSEStream([{
      id: `gen-${call}`,
      choices: [{ delta: { tool_calls: [{ index: 0, id: `call_${call}`, function: { name: "run_command", arguments: JSON.stringify({ command }) } }] } }],
      usage: { prompt_tokens: 20, completion_tokens: 10 },
    }]),
  };
}
function textReply(call, text) {
  return {
    ok: true,
    body: buildSSEStream([{
      id: `gen-${call}`,
      choices: [{ delta: { content: text }, finish_reason: "stop" }],
      usage: { prompt_tokens: 20, completion_tokens: 10 },
    }]),
  };
}

async function loadAgent() {
  const { initRegistry } = await import("../../src/tools/registry.js");
  const perms = await import("../../src/tools/permissions.js");
  const { runAgent } = await import("../../src/agent/agent.js");
  initRegistry(store);
  return { perms, runAgent };
}
const convo = [
  { role: "system", content: "You are helpful" },
  { role: "user", content: "check the scripts" },
];

describe("an early stop is shown to the operator", () => {
  it("streams the denial-loop reason through onToken", async () => {
    let call = 0;
    globalThis.fetch = vi.fn(async () => toolCallReply(++call, "rm -rf ./tmp-x"));
    const { perms, runAgent } = await loadAgent();
    perms.addBeforeHook((name) =>
      name === "run_command" ? { deny: true, reason: "dangerous command blocked", denyKey: "cmd:same" } : null
    );
    let streamed = "";
    const result = await runAgent([...convo], { onToken: (t) => { streamed += t; } });
    expect(result.stop_reason).toBe("denied");
    expect(streamed).toMatch(/Stopped: .*refused 3 times/);
  }, 30000);

  it("three different refused commands do not end the turn", async () => {
    let call = 0;
    const commands = ["cmd-a", "cmd-b", "cmd-c"];
    globalThis.fetch = vi.fn(async () => {
      call++;
      return call <= 3 ? toolCallReply(call, commands[call - 1]) : textReply(call, "Nothing ran; all three were refused.");
    });
    const { perms, runAgent } = await loadAgent();
    // Each command is refused for its own reason: a different denyKey each.
    perms.addBeforeHook((name, args) =>
      name === "run_command" ? { deny: true, reason: "blocked", denyKey: `cmd:${args.command}` } : null
    );
    const result = await runAgent([...convo], {});
    expect(result.stop_reason).not.toBe("denied");
    // The fourth call happened: the turn went on past three refusals.
    expect(call).toBeGreaterThanOrEqual(4);
  }, 30000);

  it("says so when the model keeps answering with nothing", async () => {
    let call = 0;
    globalThis.fetch = vi.fn(async () => {
      call++;
      // Before the fix this loop never ended; fail instead of hanging.
      if (call > 10) throw new Error("more than 10 model calls: the empty-answer stop did not fire");
      return textReply(call, "");
    });
    const { runAgent } = await loadAgent();
    let streamed = "";
    const result = await runAgent([...convo], { onToken: (t) => { streamed += t; } });
    expect(result.stop_reason).toBe("empty");
    expect(streamed).toMatch(/Stopped: the model returned 3 empty responses/);
    expect(call).toBe(3);
  }, 30000);

  it("counts only empty answers in a row, not scattered ones", async () => {
    // empty, tool call, empty, tool call, empty, answer: never 3 in a row.
    const script = ["", "tool", "", "tool", "", "Done."];
    let call = 0;
    globalThis.fetch = vi.fn(async () => {
      call++;
      if (call > 12) throw new Error("more than 12 model calls");
      const step = script[Math.min(call - 1, script.length - 1)];
      return step === "tool" ? toolCallReply(call, "echo hi") : textReply(call, step);
    });
    const { runAgent } = await loadAgent();
    const result = await runAgent([...convo], {});
    expect(result.stop_reason).not.toBe("empty");
  }, 30000);
});
