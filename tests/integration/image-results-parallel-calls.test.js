// Parallel tool calls that return images: every call is answered before any
// image is shown.
//
// A turn that reads two attachments at once got, per call, the tool
// message and then a user message carrying the picture, so the history read
// assistant(2 calls) -> tool -> user(image) -> tool -> user(image). Gemini
// counts the answers that follow a call turn as one block and refused the
// request: 1 function response against 2 function calls. The history is kept,
// so the session failed on every turn after that one.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { createMockStore } from "../helpers/mock-store.js";

const TMP = path.join(process.cwd(), ".tmp-5427");

vi.mock("../../src/config.js", () => ({
  config: {
    apiKey: "test-key",
    model: "test-model",
    apiUrl: "https://test.api/v1/chat/completions",
    projectRoot: process.cwd(),
    // vi.mock is hoisted above the imports, so no `path` here.
    sessionsDir: `${process.cwd()}/.tmp-5427/sessions`,
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

function sse(delta) {
  const text = `data: ${JSON.stringify({ id: "gen-1", choices: [{ delta }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`;
  const bytes = new TextEncoder().encode(text);
  let done = false;
  return new ReadableStream({ pull(c) { if (done) { c.close(); return; } c.enqueue(bytes); done = true; } });
}

// 1x1 PNG
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

const isImage = (m) => Array.isArray(m.content) && m.content.some((p) => p.type === "image_url");
const call = (index, id, name, args) => ({ index, id, function: { name, arguments: JSON.stringify(args) } });

// The model makes `calls` in one answer, then answers in text. Returns the
// request bodies of the agent loop, the ones that carry tools.
async function run(calls) {
  const loop = [];
  let asked = false;
  globalThis.fetch = vi.fn(async (url, init) => {
    const body = JSON.parse(init.body);
    if (!(body.tools || []).length) return { ok: true, body: sse({ content: "ok" }) };
    loop.push(body);
    if (!asked) {
      asked = true;
      return { ok: true, body: sse({ tool_calls: calls }) };
    }
    // A request that carries an image is sent without streaming (client.js).
    if (body.stream === false) {
      return { ok: true, json: async () => ({ id: "gen-2", choices: [{ message: { role: "assistant", content: "done" } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }) };
    }
    return { ok: true, body: sse({ content: "done" }) };
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
    { role: "user", content: "Compare the two pictures in .tmp-5427." },
  ], {}, { sessionId: "t5427" });
  return { loop, result };
}

// What follows the assistant message that made the calls, in the next request.
function afterCalls(body) {
  const at = body.messages.findIndex((m) => m.role === "assistant" && m.tool_calls?.length);
  expect(at).toBeGreaterThan(-1);
  return { asked: body.messages[at].tool_calls.map((tc) => tc.id), rest: body.messages.slice(at + 1) };
}

let originalFetch;
beforeEach(() => {
  originalFetch = globalThis.fetch;
  process.env.FLINT_TOOL_MODE = "search";
  mkdirSync(TMP, { recursive: true });
  writeFileSync(path.join(TMP, "a.png"), PNG);
  writeFileSync(path.join(TMP, "b.png"), PNG);
  writeFileSync(path.join(TMP, "note.txt"), "a note\n");
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.FLINT_TOOL_MODE;
  rmSync(TMP, { recursive: true, force: true });
});

describe("parallel tool calls that return images", () => {
  it("two images: both calls are answered in one run, then both images follow", async () => {
    const { loop, result } = await run([
      call(0, "v1", "view_image", { path: ".tmp-5427/a.png" }),
      call(1, "v2", "view_image", { path: ".tmp-5427/b.png" }),
    ]);
    expect(loop.length).toBe(2);
    const { asked, rest } = afterCalls(loop[1]);
    expect(asked).toEqual(["v1", "v2"]);
    expect(rest.slice(0, 2).map((m) => [m.role, m.tool_call_id])).toEqual([["tool", "v1"], ["tool", "v2"]]);
    // Asked for together, shown together: neither is replaced by its caption.
    expect(rest.slice(2).filter(isImage).length).toBe(2);
    expect(rest.some((m) => m.role === "tool" && rest.indexOf(m) >= 2)).toBe(false);
    expect(result.text).toContain("done");
  }, 30000);

  it("an image before a text result: the text call's answer is not pushed behind the image", async () => {
    const { loop } = await run([
      call(0, "v1", "view_image", { path: ".tmp-5427/a.png" }),
      call(1, "r1", "read_file", { path: ".tmp-5427/note.txt" }),
    ]);
    const { rest } = afterCalls(loop[1]);
    expect(rest.slice(0, 2).map((m) => [m.role, m.tool_call_id])).toEqual([["tool", "v1"], ["tool", "r1"]]);
    expect(rest.slice(2).filter(isImage).length).toBe(1);
  }, 30000);
});
