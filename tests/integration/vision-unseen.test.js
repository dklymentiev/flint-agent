// A model that cannot see images must not lose the turn to an image, and it
// is told the fact instead of being sent the picture.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { createMockStore } from "../helpers/mock-store.js";

const TMP = path.join(process.cwd(), ".tmp-5016");

vi.mock("../../src/config.js", () => ({
  config: {
    apiKey: "test-key",
    model: "test-model",
    apiUrl: "https://test.api/v1/chat/completions",
    projectRoot: process.cwd(),
    // vi.mock is hoisted above the imports, so no `path` here.
    sessionsDir: `${process.cwd()}/.tmp-5016/sessions`,
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

const hasImage = (body) => body.messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === "image_url"));
const text = (body) => JSON.stringify(body.messages);

// The model asks for view_image once, then answers. `refuseImages` makes the
// provider reject any payload carrying an image, the way OpenRouter does for a
// text-only model.
async function run({ sees, refuseImages }) {
  const loop = [];
  let asked = false;
  globalThis.fetch = vi.fn(async (url, init) => {
    const body = JSON.parse(init.body);
    if (!(body.tools || []).length) return { ok: true, body: sse({ content: "ok" }) };
    loop.push(body);
    if (refuseImages && hasImage(body)) {
      const msg = '{"error":{"message":"No endpoints found that support image input","code":404}}';
      return { ok: false, status: 404, headers: { get: () => null }, text: async () => msg };
    }
    if (!asked) {
      asked = true;
      return { ok: true, body: sse({ tool_calls: [{ index: 0, id: "v1", function: { name: "view_image", arguments: JSON.stringify({ path: ".tmp-5016/pic.png" }) } }] }) };
    }
    return { ok: true, body: sse({ content: "done" }) };
  });

  vi.resetModules();
  const vision = await import("../../src/agent/vision.js");
  const { initRegistry } = await import("../../src/tools/registry.js");
  const { runAgent } = await import("../../src/agent/agent.js");
  vision.resetVision();
  if (sees !== null) vision.setModelSeesImages(sees, "provider-metadata");
  initRegistry(createMockStore());

  const result = await runAgent([
    { role: "system", content: "You are helpful" },
    { role: "user", content: "Look at .tmp-5016/pic.png." },
  ], {}, { sessionId: "t5016" });
  return { loop, result, vision };
}

let originalFetch;
beforeEach(() => {
  originalFetch = globalThis.fetch;
  process.env.FLINT_TOOL_MODE = "search";
  mkdirSync(TMP, { recursive: true });
  writeFileSync(path.join(TMP, "pic.png"), PNG);
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.FLINT_TOOL_MODE;
  rmSync(TMP, { recursive: true, force: true });
});

describe("a model that cannot see images", () => {
  it("known from the provider: no image is sent, the model reads the fact and the saved path", async () => {
    const { loop, result } = await run({ sees: false, refuseImages: true });
    expect(loop.length).toBe(2);
    expect(hasImage(loop[1])).toBe(false);
    expect(text(loop[1])).toContain("cannot view images");
    expect(text(loop[1])).toMatch(/saved at [^"]*t5016-img-/);
    expect(result.stop_reason).not.toBe("error");
  }, 30000);

  it("unknown until the provider refuses: the refusal is learned, the image is dropped, the turn goes on", async () => {
    const { loop, result, vision } = await run({ sees: null, refuseImages: true });
    expect(hasImage(loop[1])).toBe(true);
    expect(hasImage(loop[2])).toBe(false);
    expect(text(loop[2])).toContain("cannot view images");
    expect(result.stop_reason).not.toBe("error");
    expect(result.text).toContain("done");
    expect(vision.modelSeesImages()).toBe(false);
  }, 30000);

  it("a model that sees images still gets the image", async () => {
    const { loop } = await run({ sees: true, refuseImages: false });
    expect(hasImage(loop[1])).toBe(true);
    expect(text(loop[1])).not.toContain("cannot view images");
  }, 30000);
});
