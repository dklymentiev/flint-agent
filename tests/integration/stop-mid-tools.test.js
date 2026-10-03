// Stopping a turn halfway through several tool calls leaves a history the next
// turn can carry on from (owner, 2026-10-01: "if I stop it after an hour, does
// it start from scratch?").
//
// The assistant message with every requested call is in the history before the
// first one runs. An abort between calls used to leave the rest without a
// result, and a tool call with no result is a request providers refuse.

import { it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../src/config.js", () => ({
  config: {
    apiKey: "test-key", model: "test-model", intentModel: "test/intent-model",
    apiUrl: "https://test.api/v1/chat/completions", provider: "openrouter",
    projectRoot: process.cwd(), maxIterations: 50, maxResponseTokens: 2048,
    maxCostPerAction: 0, sessionBudget: 0, selfVerify: "off", headless: false,
    fallbackAllTools: false, sessionsDir: process.env.FLINT_DATA_DIR || process.cwd(),
    workdir: process.cwd(),
  },
}));
vi.mock("../../src/agent/modes.js", () => ({ getModeForIntent: () => null, listModes: () => [] }));
vi.mock("../../src/memory/facts.js", () => ({ extractFacts: () => [], addFact: () => {}, formatForPrompt: () => "" }));
vi.mock("../../src/memory/user-model.js", () => ({ observeUser: () => {}, formatForPrompt: () => "" }));
vi.mock("../../src/memory/patterns.js", () => ({ recordPattern: () => {}, compilePreferences: () => ({}), formatForPrompt: () => "" }));
// The tools themselves are not the subject: the first is slow, the rest quick.
vi.mock("../../src/tools/permissions.js", async (orig) => ({
  ...(await orig()),
  executeToolWithPermissions: async (name) => {
    if (name === "run_command") await new Promise((r) => setTimeout(r, 500));
    return { result: `${name} ok`, denied: false };
  },
}));

function sse(delta) {
  const text = `data: ${JSON.stringify({ id: "g1", choices: [{ delta }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`;
  const bytes = new TextEncoder().encode(text);
  let done = false;
  return new ReadableStream({ pull(c) { if (done) { c.close(); return; } c.enqueue(bytes); done = true; } });
}
const MANIFEST = { intent: "complex_multi", tools: ["read_file", "run_command", "glob"], assessment: "normal", requires_prior_tool_call: [], user_wants: "x", reason: "x" };
const isClassifier = (b) => String((b.messages || []).find((m) => m.role === "system")?.content || "").includes("INTENT_CLASSES");
const threeTools = () => sse({ tool_calls: [
  { index: 0, id: "c-slow", function: { name: "run_command", arguments: JSON.stringify({ command: "build" }) } },
  { index: 1, id: "c-read", function: { name: "read_file", arguments: JSON.stringify({ path: "a.txt" }) } },
  { index: 2, id: "c-glob", function: { name: "glob", arguments: JSON.stringify({ pattern: "*.js" }) } },
] });

let originalFetch;
beforeEach(() => { originalFetch = globalThis.fetch; });
afterEach(() => { globalThis.fetch = originalFetch; });

it("answers every call left unrun when the turn is stopped", async () => {
  let agentCalls = 0;
  globalThis.fetch = vi.fn(async (_url, init) => {
    const b = JSON.parse(init.body);
    if (isClassifier(b)) return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(MANIFEST) } }] }), text: async () => "" };
    agentCalls++;
    if (agentCalls === 1) return { ok: true, body: threeTools() };
    return { ok: true, body: sse({ content: "done" }) };
  });
  const { initRegistry } = await import("../../src/tools/registry.js");
  const { runAgent } = await import("../../src/agent/agent.js");
  const { createMockStore } = await import("../helpers/mock-store.js");
  initRegistry(createMockStore());

  const loop = new AbortController();
  const msgs = [{ role: "system", content: "s" }, { role: "user", content: "go" }];
  setTimeout(() => loop.abort(), 200); // during the slow first call

  await expect(runAgent(msgs, {}, { signal: loop.signal })).rejects.toMatchObject({ name: "AbortError" });

  const calls = msgs.filter((m) => m.role === "assistant").flatMap((m) => (m.tool_calls || []).map((t) => t.id));
  const results = new Map(msgs.filter((m) => m.role === "tool").map((m) => [m.tool_call_id, String(m.content)]));
  expect(calls).toEqual(["c-slow", "c-read", "c-glob"]);
  // Every call has exactly one result: the one that ran, and two "not run".
  for (const id of calls) expect(results.has(id), `${id} has no result`).toBe(true);
  expect(results.get("c-slow")).toContain("run_command ok");
  expect(results.get("c-read")).toContain("Not run");
  expect(results.get("c-glob")).toContain("Not run");
}, 30000);
