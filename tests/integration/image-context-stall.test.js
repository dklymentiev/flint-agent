// An image in the context must not make a working model look silent.
//
// A request that carried an image used to be sent without streaming. The
// stall watchdog waits for the first sign of an answer, and a call that is
// not streamed gives none until the whole answer is there, so every answer
// that took longer than the watchdog's limit was dropped and asked for again.
// An agent that had taken a screenshot lost a 39-minute turn that way: the
// picture stayed in the context, and three calls in a row were dropped.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { createMockStore } from "../helpers/mock-store.js";

const TMP = path.join(process.cwd(), ".tmp-image-stall");

vi.mock("../../src/config.js", () => ({
  config: {
    apiKey: "test-key",
    model: "test-model",
    apiUrl: "https://test.api/v1/chat/completions",
    projectRoot: process.cwd(),
    // vi.mock is hoisted above the imports, so no `path` here.
    sessionsDir: `${process.cwd()}/.tmp-image-stall/sessions`,
    maxIterations: 50,
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

const WATCHDOG_MS = 300;
const ANSWER_TAKES_MS = 1200;

const enc = new TextEncoder();
const frame = (delta) => enc.encode(`data: ${JSON.stringify({ id: "gen-1", choices: [{ delta }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\n`);
const DONE = enc.encode("data: [DONE]\n\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sse(delta) {
  let sent = false;
  return new ReadableStream({ pull(c) { if (sent) { c.close(); return; } c.enqueue(frame(delta)); c.enqueue(DONE); sent = true; } });
}

// A model that reasons for ANSWER_TAKES_MS, a chunk every 100 ms, then answers.
function slowReasoningStream(signal) {
  return new ReadableStream({
    async start(c) {
      signal?.addEventListener("abort", () => { try { c.error(new Error("aborted")); } catch {} }, { once: true });
      try {
        for (let t = 0; t < ANSWER_TAKES_MS; t += 100) {
          await sleep(100);
          c.enqueue(frame({ reasoning: "thinking " }));
        }
        c.enqueue(frame({ content: "done" }));
        c.enqueue(DONE);
        c.close();
      } catch {}
    },
  });
}

// A connection that accepts the request and never sends a byte.
function silentStream(signal) {
  return new ReadableStream({
    start(c) { signal?.addEventListener("abort", () => { try { c.error(new Error("aborted")); } catch {} }, { once: true }); },
  });
}

// The same answer without streaming: nothing at all until it is whole.
function slowJson(signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve({
      ok: true,
      json: async () => ({ id: "gen-2", choices: [{ message: { role: "assistant", content: "done" } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
    }), ANSWER_TAKES_MS);
    signal?.addEventListener("abort", () => { clearTimeout(timer); reject(Object.assign(new Error("aborted"), { name: "AbortError" })); }, { once: true });
  });
}

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const hasImage = (body) => body.messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === "image_url"));

// The model looks at one picture, then is asked again with the picture in the
// context. `afterImage` is how the provider behaves on that second call.
async function run(afterImage) {
  const withImage = [];
  let asked = false;
  globalThis.fetch = vi.fn(async (url, init) => {
    const body = JSON.parse(init.body);
    if (!(body.tools || []).length) return { ok: true, body: sse({ content: "ok" }) };
    if (!asked) {
      asked = true;
      return { ok: true, body: sse({ tool_calls: [{ index: 0, id: "v1", function: { name: "view_image", arguments: JSON.stringify({ path: ".tmp-image-stall/pic.png" }) } }] }) };
    }
    withImage.push({ stream: body.stream, image: hasImage(body) });
    return afterImage(body, init.signal);
  });

  vi.resetModules();
  const vision = await import("../../src/agent/vision.js");
  const { initRegistry } = await import("../../src/tools/registry.js");
  const { runAgent } = await import("../../src/agent/agent.js");
  vision.resetVision();
  vision.setModelSeesImages(true, "provider-metadata");
  initRegistry(createMockStore());

  const result = await runAgent([
    { role: "system", content: "You are helpful" },
    { role: "user", content: "Look at .tmp-image-stall/pic.png." },
  ], {}, { sessionId: "t-image-stall" });
  return { withImage, result };
}

let originalFetch;
beforeEach(() => {
  originalFetch = globalThis.fetch;
  process.env.FLINT_TOOL_MODE = "search";
  process.env.AGENT_FIRST_TOKEN_TIMEOUT_MS = String(WATCHDOG_MS);
  process.env.FLINT_API_RETRY_MS = "0";
  mkdirSync(TMP, { recursive: true });
  writeFileSync(path.join(TMP, "pic.png"), PNG);
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.FLINT_TOOL_MODE;
  delete process.env.AGENT_FIRST_TOKEN_TIMEOUT_MS;
  delete process.env.FLINT_API_RETRY_MS;
  rmSync(TMP, { recursive: true, force: true });
});

describe("a model call with an image in the context", () => {
  it("is not dropped while the model is reasoning, however long the answer takes", async () => {
    const { withImage, result } = await run((body, signal) => (
      body.stream === false ? slowJson(signal) : { ok: true, body: slowReasoningStream(signal) }
    ));
    // The picture really was in the request, so this is the case in question.
    expect(withImage[0].image).toBe(true);
    // One call, answered. Dropped calls would show up here as repeats.
    expect(withImage.length).toBe(1);
    expect(result.stop_reason).not.toBe("stall");
    expect(result.text).toContain("done");
  }, 30000);

  it("is still dropped and retried when the connection really is silent", async () => {
    const never = (signal) => new Promise((_, reject) => {
      signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
    });
    const { withImage, result } = await run((body, signal) => (
      body.stream === false ? never(signal) : { ok: true, body: silentStream(signal) }
    ));
    expect(withImage[0].image).toBe(true);
    expect(withImage.length).toBe(3);
    expect(result.stop_reason).toBe("stall");
  }, 30000);
});
