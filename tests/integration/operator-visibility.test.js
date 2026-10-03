// The turn must not be able to lose its tools to a guess, and must not be
// able to pretend that a tool call it could not run was work.
//
// Four failures from the evening of 2026-09-29, in one file because they are
// one thing: the operator could not tell what Flint was doing.
//
//   1. "Read <brief> and do what it says"  -> file_read (1 tool) twice in a row
//   2. "Continue the task: ... commit."     -> chat (0 tools), and the model
//      then wrote its tool calls out as TEXT — 9 KB that never ran
//   3. a call sent at 20:40:49 never returned; the timeout fired at 20:50:49
//   4. the model answered with nothing, or the provider said "rate-limited
//      upstream", and Flint stopped at once instead of waiting and trying

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../src/config.js", () => ({
  config: {
    apiKey: "test-key",
    model: "test-model",
    intentModel: "test/intent-model",
    apiUrl: "https://test.api/v1/chat/completions",
    provider: "openrouter",
    projectRoot: process.cwd(),
    maxIterations: 50,
    maxResponseTokens: 2048,
    maxCostPerAction: 0,
    sessionBudget: 0,
    selfVerify: "off",
    headless: false,
    fallbackAllTools: false,
    sessionsDir: process.env.FLINT_DATA_DIR || process.cwd(),
    workdir: process.cwd(),
  },
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

// Zero-width space, built from its codepoint: a literal one cannot be seen in
// an editor, cannot be reviewed in a diff, and is dropped by editors — which is
// part of why the model emits it and part of why the bug survived.
const ZW = String.fromCharCode(0x200b);
const OPEN = `<${ZW}tool_call>`;
const CLOSE = `<${ZW}/tool_call>`;

function sse(delta) {
  const text = `data: ${JSON.stringify({ id: "gen-1", choices: [{ delta }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`;
  const bytes = new TextEncoder().encode(text);
  let done = false;
  return new ReadableStream({ pull(c) { if (done) { c.close(); return; } c.enqueue(bytes); done = true; } });
}

function textSse(content) {
  return sse({ content });
}

function toolSse(name, args) {
  return sse({ tool_calls: [{ index: 0, id: `c-${name}`, function: { name, arguments: JSON.stringify(args) } }] });
}

let originalFetch;
beforeEach(() => {
  originalFetch = globalThis.fetch;
  // Keep the waits instant; the growth itself is unit-tested in backoff.test.js.
  process.env.AGENT_BACKOFF_MS = "1";
  process.env.AGENT_FIRST_TOKEN_TIMEOUT_MS = "400";
  process.env.AGENT_TEMP_ERROR_RETRIES = "3";
  // The classifier's own budget, and the one that made this file depend on
  // machine load. intent.js gave the classifier call a hard 15 s wall-clock
  // deadline, and on exhaustion returned the all-tools manifest -- silently,
  // because a fallback is indistinguishable from a real classification in the
  // output. Under a loaded run the deadline fired before the mocked response
  // was processed, and the test that asserts "exactly these two tools" got all
  // 43 instead. A 60 s budget cannot be hit by a mock that answers immediately
  // however busy the machine is.
  process.env.INTENT_TIMEOUT_MS = "60000";
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.FLINT_TOOL_MODE;
  delete process.env.AGENT_BACKOFF_MS;
  delete process.env.AGENT_FIRST_TOKEN_TIMEOUT_MS;
  delete process.env.AGENT_TEMP_ERROR_RETRIES;
  delete process.env.AGENT_STALL_MAX_ATTEMPTS;
  delete process.env.INTENT_TIMEOUT_MS;
});

/** Load the loop with a registry, once per file. */
// Loaded once, not per test.
//
// This used to run inside every test, re-importing the agent loop, the tool
// registry and the store each time — 7-9s of module loading per test on this
// machine, against a 30s budget. Under a loaded full run that import alone ate
// most of the budget and the first test in the file timed out. The imports are
// hoisted; the state each test needs is the registry, which is re-initialised
// per test because it holds the tool list the assertions read.
let _modules = null;
async function loadLoop() {
  if (!_modules) {
    const { initRegistry } = await import("../../src/tools/registry.js");
    const { runAgent } = await import("../../src/agent/agent.js");
    const { createMockStore } = await import("../helpers/mock-store.js");
    _modules = { initRegistry, runAgent, createMockStore };
  }
  _modules.initRegistry(_modules.createMockStore());
  return { runAgent: _modules.runAgent };
}

/**
 * A classifier answer, as the classifier would actually reply.
 *
 * Every fetch in this file has to answer this first. The classifier runs
 * before the loop on every turn, and when its reply is not valid JSON it
 * silently returns the all-tools fallback — which would hand the turn every
 * tool and make the narrowing under test disappear. That is a real property of
 * the code (a broken classifier must not cost capability), and it is exactly
 * why a test that skips this step proves nothing.
 */
function classifierReply(manifest) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: JSON.stringify(manifest) } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }),
    text: async () => "",
  };
}

/** Does this request carry the classifier's system prompt? */
function isClassifierCall(body) {
  const systemText = String((body.messages || []).find((m) => m.role === "system")?.content || "");
  return systemText.includes("INTENT_CLASSES");
}

/** A text-only class: the guess that caused the whole evening. */
const CHAT_MANIFEST = {
  intent: "chat",
  tools: [],
  assessment: "normal",
  requires_prior_tool_call: [],
  user_wants: "a short reply",
  reason: "small talk",
};

/** A tool-backed class, for the tests that are not about the guess. */
const FULL_MANIFEST = {
  intent: "complex_multi",
  tools: ["read_file", "write_file", "edit_file", "run_command", "think", "web_search"],
  assessment: "normal",
  requires_prior_tool_call: [],
  user_wants: "do the work",
  reason: "multi-step",
};

describe("a mid-task message keeps the tools the task needs", () => {
  it("does not strip the tools off a continuation, and says what it did", async () => {
    let agentToolCounts = [];
    globalThis.fetch = vi.fn(async (url, init) => {
      const body = JSON.parse(init.body);
      const systemText = String((body.messages || []).find((m) => m.role === "system")?.content || "");

      // The classifier runs first, non-streaming, and must be answered with a
      // real manifest. Answering it with prose is what silently turns the
      // classifier into the all-tools fallback, which would hide the very
      // narrowing this test is about.
      if (systemText.includes("INTENT_CLASSES")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [{ message: { content: JSON.stringify({
              intent: "chat",
              tools: [],
              assessment: "normal",
              requires_prior_tool_call: [],
              user_wants: "so why did you stop",
              reason: "short acknowledgement",
            }) } }],
            usage: { prompt_tokens: 10, completion_tokens: 5 },
          }),
          text: async () => "",
        };
      }

      agentToolCounts.push((body.tools || []).length);
      return { ok: true, body: textSse("The commit is made and the tests pass.") };
    });

    const { runAgent } = await loadLoop();
    const notes = [];
    const messages = [
      { role: "system", content: "You are helpful" },
      { role: "user", content: "fix the failing test" },
      { role: "assistant", content: "", tool_calls: [{ id: "t1", function: { name: "read_file", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "t1", content: "the test is failing" },
      // The message from the log: a continuation, arriving mid-task.
      { role: "user", content: "Continue the task: write the fix and the tests as files, run them, commit." },
    ];
    const res = await runAgent(messages, { onScopeNote: (note) => notes.push(note) });

    expect(res.stop_reason).toBe("done");
    // The turn got a real tool surface despite the class it was given.
    expect(agentToolCounts.length).toBeGreaterThan(0);
    for (const count of agentToolCounts) expect(count).toBeGreaterThan(0);
    // And the operator was told, rather than left to guess.
    expect(notes.length).toBeGreaterThan(0);
    expect(notes.join(" ")).toMatch(/mode \w+/);
    expect(notes.join(" ")).toMatch(/\d+ of \d+ tools/);
  }, 60000);

  it("leaves a first message that names its whole job exactly as classified", async () => {
    let agentToolCounts = [];
    globalThis.fetch = vi.fn(async (url, init) => {
      const body = JSON.parse(init.body);
      const systemText = String((body.messages || []).find((m) => m.role === "system")?.content || "");
      if (systemText.includes("INTENT_CLASSES")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [{ message: { content: JSON.stringify({
              intent: "web_search",
              tools: ["web_search", "web_fetch"],
              assessment: "normal",
              requires_prior_tool_call: [],
              user_wants: "find the repo",
              reason: "a web lookup",
            }) } }],
            usage: { prompt_tokens: 10, completion_tokens: 5 },
          }),
          text: async () => "",
        };
      }
      agentToolCounts.push((body.tools || []).map((t) => t.function?.name || t.name));
      return { ok: true, body: textSse("It is on GitHub.") };
    });

    const { runAgent } = await loadLoop();
    const notes = [];
    const messages = [
      { role: "system", content: "You are helpful" },
      { role: "user", content: "search the web for the flint agent repo" },
    ];
    await runAgent(messages, { onScopeNote: (note) => notes.push(note) });

    // Narrowed, and only to the two tools the job needs — no widening, and
    // nothing to announce beyond the class. Compared as a set: the registry
    // hands tools over in its own order, not in the order the manifest named
    // them, and the order carries no meaning here.
    expect(agentToolCounts.length).toBeGreaterThan(0);
    for (const names of agentToolCounts) {
      expect([...names].sort()).toEqual(["web_fetch", "web_search"]);
    }
    expect(notes.join(" ")).toMatch(/mode web_search/);
    expect(notes.join(" ")).toMatch(/2 of \d+ tools/);
  }, 60000);
});

describe("a tool call written as text", () => {
  it("is reported as not run, not printed as progress", async () => {
    let n = 0;
    globalThis.fetch = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      if (isClassifierCall(body)) return classifierReply(CHAT_MANIFEST);
      n++;
      // The shape from the log: a tool call in the answer body.
      const text = `${OPEN}<function=edit_file>{"path":"src/a.js","content":"${"x".repeat(500)}"}${CLOSE}`;
      return { ok: true, body: textSse(text) };
    });

    const { runAgent } = await loadLoop();
    const messages = [
      { role: "system", content: "You are helpful" },
      { role: "user", content: "apply the fix" },
    ];
    const res = await runAgent(messages, {});

    // Not `done`. The turn did no work and says so.
    expect(res.stop_reason).toBe("text-tool-call");
    expect(res.text).toContain("nothing ran");
    expect(res.text).toContain("edit_file");
    expect(res.text).not.toMatch(/\b(fixed|completed|applied)\b/i);
  }, 60000);

  it("names a call it could not read rather than pretending there was none", async () => {
    globalThis.fetch = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      if (isClassifierCall(body)) return classifierReply(CHAT_MANIFEST);
      // A tag that opens and never closes — cut off by the model's own limit.
      return { ok: true, body: textSse(`${OPEN}{"name":"write_file","arguments":{"path":"a.js","content":"trunc`) };
    });

    const { runAgent } = await loadLoop();
    const messages = [
      { role: "system", content: "You are helpful" },
      { role: "user", content: "apply the fix" },
    ];
    const res = await runAgent(messages, {});
    expect(res.stop_reason).toBe("text-tool-call");
    expect(res.text).toContain("nothing ran");
  }, 60000);
});

describe("a model call that never answers", () => {
  it("drops it, retries, and names each attempt", async () => {
    let attempts = 0;
    globalThis.fetch = vi.fn(async (_url, init) => {
      const req = JSON.parse(init.body);
      if (isClassifierCall(req)) return classifierReply(FULL_MANIFEST);
      attempts++;
      // The provider accepts and never answers — a hung connection.
      return {
        ok: true,
        status: 200,
        body: new ReadableStream({ start() { /* never enqueues, never closes */ } }),
      };
    });

    const { runAgent } = await loadLoop();
    const messages = [
      { role: "system", content: "You are helpful" },
      { role: "user", content: "do the thing" },
    ];
    const activities = [];
    // Cap the attempts so the test does not sit through three real stalls.
    process.env.AGENT_STALL_MAX_ATTEMPTS = "2";
    const res = await runAgent(messages, { onActivity: (a) => activities.push(a) });

    // Two hung calls dropped, then the turn stopped with the reason.
    expect(res.stop_reason).toBe("stall");
    expect(res.text).toContain("no answer for");
    expect(res.text).toContain("type: continue");
    // The operator saw each attempt, with its number.
    const stalls = activities.filter((a) => a.kind === "stall");
    expect(stalls.length).toBeGreaterThan(0);
    expect(stalls[0].label).toContain("retrying");
    expect(stalls[0].label).toContain("1 of");
  }, 60000);
});

describe("empty answers and temporary refusals are waited out", () => {
  it("waits and retries instead of stopping at once", async () => {
    let n = 0;
    globalThis.fetch = vi.fn(async (_url, init) => {
      const req = JSON.parse(init.body);
      if (isClassifierCall(req)) return classifierReply(FULL_MANIFEST);
      n++;
      // Empty, empty, then an answer. Stopping at once would leave the work
      // undone; the loop must wait and go on by itself.
      if (n <= 2) return { ok: true, body: textSse("") };
      return { ok: true, body: textSse("Recovered and finished.") };
    });

    const { runAgent } = await loadLoop();
    const messages = [
      { role: "system", content: "You are helpful" },
      { role: "user", content: "do the thing" },
    ];
    const activities = [];
    const res = await runAgent(messages, { onActivity: (a) => activities.push(a) });

    expect(res.stop_reason).toBe("done");
    expect(res.text).toContain("Recovered");
    // The operator was shown the countdown while Flint waited.
    const waits = activities.filter((a) => a.kind === "wait");
    expect(waits.length).toBeGreaterThan(0);
    expect(waits[0].label).toMatch(/not answering|retrying in/);
  }, 60000);

  it("waits out an overloaded upstream (400 rate-limited) and carries on", async () => {
    let n = 0;
    globalThis.fetch = vi.fn(async (_url, init) => {
      const req = JSON.parse(init.body);
      if (isClassifierCall(req)) return classifierReply(FULL_MANIFEST);
      n++;
      if (n === 1) {
        // What an overloaded OpenRouter backend sends: a 400, which used to be
        // treated as fatal in three places.
        return {
          ok: false, status: 400,
          text: async () => '{"error":{"message":"Provider returned error: rate-limited upstream"}}',
          json: async () => ({}),
        };
      }
      return { ok: true, body: textSse("Back and finished.") };
    });

    const { runAgent } = await loadLoop();
    const messages = [
      { role: "system", content: "You are helpful" },
      { role: "user", content: "do the thing" },
    ];
    const res = await runAgent(messages, {});
    expect(res.stop_reason).toBe("done");
    expect(res.text).toContain("Back and finished");
  }, 60000);

  it("still stops at once for a bad key — waiting cannot fix that", async () => {
    let n = 0;
    globalThis.fetch = vi.fn(async (_url, init) => {
      const req = JSON.parse(init.body);
      if (isClassifierCall(req)) return classifierReply(FULL_MANIFEST);
      n++;
      if (n === 1) return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "ok" } }] }), text: async () => "" };
      return { ok: false, status: 401, text: async () => '{"error":"bad key"}', json: async () => ({}) };
    });

    const { runAgent } = await loadLoop();
    const messages = [
      { role: "system", content: "You are helpful" },
      { role: "user", content: "do the thing" },
    ];
    const res = await runAgent(messages, {});
    expect(res.stop_reason).toBe("auth");
  }, 60000);
});