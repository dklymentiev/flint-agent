// Steering must apply to one completion and then be gone.
//
// Measured on ten readiness probes 2026-09-21, from the payloads in
// sessions/*.messages.jsonl: [OUTCOME] was asked 8 times and sent to the model
// 202 times, up to three copies in a single call, and a fresh turn started with
// up to six leftover nudges already in its window. Twelve places in
// src/agent/agent.js push a system message into the conversation and none of
// them ever takes one out.
//
// The checks look at what was SENT and at what stayed in the conversation,
// never at wording.

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

/** Every steering marker the loop can inject, so the checks name none of them by hand. */
const STEERING_MARKERS = /\[(OUTCOME|SAFETY|SUPERVISOR|VERIFY|BUDGET|SESSION BUDGET|SECURITY|REFLECTION)/;

const systemText = (m) => (m.role === "system" && typeof m.content === "string" ? m.content : "");

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

/** One turn on a conversation the caller owns, so a second turn can follow it. */
async function turn(messages, userText) {
  const { initRegistry } = await import("../../src/tools/registry.js");
  const { runAgent } = await import("../../src/agent/agent.js");
  initRegistry(store);
  messages.push({ role: "user", content: userText });
  return runAgent(messages, {});
}

/** A turn that looks around, changes nothing, and so earns a nudge. */
function looksAndChangesNothing(payloads) {
  let calls = 0;
  return vi.fn(async (_url, opts) => {
    calls++;
    payloads.push(JSON.parse(opts.body).messages);
    if (calls === 1) return callTool("list_directory", { path: tmp.path });
    return say("Looked at it.");
  });
}

describe("steering applies to one completion", () => {
  it("does not stay in the conversation after the turn", async () => {
    const payloads = [];
    globalThis.fetch = looksAndChangesNothing(payloads);

    const messages = [{ role: "system", content: "You are helpful" }];
    await turn(messages, "Fix the counter");

    // Whatever was said to steer that turn is not part of the record of it.
    const left = messages.filter((m) => STEERING_MARKERS.test(systemText(m)));
    expect(left.map(systemText)).toEqual([]);
  }, 30000);

  it("does not carry into the next turn", async () => {
    const first = [];
    globalThis.fetch = looksAndChangesNothing(first);
    const messages = [{ role: "system", content: "You are helpful" }];
    await turn(messages, "Fix the counter");

    const second = [];
    globalThis.fetch = looksAndChangesNothing(second);
    await turn(messages, "Now look at the other one");

    // Nothing the first turn injected may steer the second.
    const leaked = second.flat().map(systemText).filter((t) => STEERING_MARKERS.test(t));
    expect(leaked).toEqual([]);
  }, 30000);

  it("never sends the same steering line twice in one call", async () => {
    const payloads = [];
    globalThis.fetch = looksAndChangesNothing(payloads);
    const messages = [{ role: "system", content: "You are helpful" }];
    await turn(messages, "Fix the counter");
    await turn(messages, "Fix the other counter");
    await turn(messages, "And the third one");

    for (const payload of payloads) {
      const steering = payload.map(systemText).filter((t) => STEERING_MARKERS.test(t));
      expect(new Set(steering).size).toBe(steering.length);
    }
  }, 30000);
});
