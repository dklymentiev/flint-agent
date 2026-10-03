// Model check (docs/model-check.md, M1-M4).
import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

vi.mock("../../src/logging/logger.js", () => ({
  createLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
}));

const mc = await import("../../src/model-check.js");
const fm = await import("../../src/free-models.js");

const tmp = () => mkdtempSync(path.join(tmpdir(), "flint-check-"));
const task = (id) => mc.CHECK_TASKS.find((t) => t.id === id);
afterEach(() => { const f = path.join(process.env.FLINT_DATA_DIR, "model-checks.json"); if (existsSync(f)) rmSync(f); });

/** What a capable agent does for each task, in `dir`; `wrong` does it badly. */
function act(id, dir, wrong = false) {
  switch (id) {
    case "write-file": writeFileSync(path.join(dir, "hello.txt"), wrong ? "hello" : "flint-check"); return { answer: "done", tools: [{ name: "write_file" }] };
    case "read-sum": return { answer: wrong ? "The sum is 40" : `The sum is ${mc.SUM_EXPECTED}`, tools: [{ name: "read_file" }] };
    case "edit-json": writeFileSync(path.join(dir, "config.json"), wrong ? '{"port": 8080' : JSON.stringify({ port: 8080, name: "demo" })); return { answer: "ok", tools: [{ name: "edit_file" }] };
    case "run-command": return { answer: wrong ? "6*7" : "42", tools: [{ name: "run_command" }] };
    case "multi-step":
      mkdirSync(path.join(dir, "out"), { recursive: true });
      writeFileSync(path.join(dir, "out", "a.txt"), "A");
      if (!wrong) writeFileSync(path.join(dir, "out", "b.txt"), "B");
      return { answer: "a.txt, b.txt", tools: [{ name: "create_directory" }, { name: "write_file" }, { name: "write_file" }, { name: "list_directory" }] };
    case "restraint": return wrong ? { answer: "ready", tools: [{ name: "list_directory" }] } : { answer: "ready", tools: [] };
  }
}

describe("M1 the checks", () => {
  it("six tasks, each passes on the right outcome and fails on a wrong one", () => {
    expect(mc.CHECK_TASKS.map((t) => t.id)).toEqual(["write-file", "read-sum", "edit-json", "run-command", "multi-step", "restraint"]);
    for (const t of mc.CHECK_TASKS) {
      const good = tmp();
      t.setup?.(good);
      const r = act(t.id, good);
      expect(t.check({ dir: good, ...r }), `${t.id} right`).toBe(true);
      const bad = tmp();
      t.setup?.(bad);
      const w = act(t.id, bad, true);
      expect(t.check({ dir: bad, ...w }), `${t.id} wrong`).toBe(false);
    }
  });
});

describe("M2 running a check", () => {
  it("drives the agent through the six tasks and records each", async () => {
    let closed = false;
    const startAgent = async ({ cwd }) => ({
      async ask(prompt) {
        const t = mc.CHECK_TASKS.find((x) => x.prompt === prompt);
        if (t.id === "run-command") throw new Error("timed out");
        const r = act(t.id, cwd, t.id === "restraint");
        return { ...r, tools: r.tools.map((x) => ({ ...x, isError: false })), usage: { input_tokens: 100, output_tokens: 5 } };
      },
      async close() { closed = true; },
    });
    const res = await mc.runCheck("x/model:free", { startAgent });
    expect(res.model).toBe("x/model:free");
    expect(res.tasks.map((t) => [t.id, t.passed])).toEqual([
      ["write-file", true], ["read-sum", true], ["edit-json", true], ["run-command", false], ["multi-step", true], ["restraint", false],
    ]);
    expect(res.tasks.find((t) => t.id === "run-command").error).toMatch(/timed out/);
    expect(res.tasks[4].toolCalls).toBe(4);
    expect(res.score).toBe(4);
    expect(closed).toBe(true);
  });
});

describe("M3 results", () => {
  it("are saved, and the free list ranks a fresh score above speed", async () => {
    mc.saveCheck({ model: "slow/strong:free", score: 6, checkedAt: new Date().toISOString(), tasks: [] });
    mc.saveCheck({ model: "fast/weak:free", score: 2, checkedAt: new Date().toISOString(), tasks: [] });
    mc.saveCheck({ model: "old/check:free", score: 6, checkedAt: "2026-01-01T00:00:00Z", tasks: [] });
    expect(Object.keys(mc.loadChecks())).toHaveLength(3);
    const ranked = fm.rankFree(mc.withScores([
      { id: "fast/weak:free", vendor: "fast", tps: 150, uptime: 100 },
      { id: "slow/strong:free", vendor: "slow", tps: 20, uptime: 100 },
      { id: "old/check:free", vendor: "old", tps: 90, uptime: 100 },
    ], new Date()));
    expect(ranked.map((m) => m.id)).toEqual(["slow/strong:free", "fast/weak:free", "old/check:free"]);
    expect(ranked.find((m) => m.id === "old/check:free")).toMatchObject({ checkScore: 6, scoreFresh: false });
  });
});

describe("M4 the command", () => {
  async function setup() {
    const { createMockStore } = await import("../helpers/mock-store.js");
    const { initCommands, tryHandleCommand } = await import("../../src/commands/registry.js");
    const store = createMockStore();
    initCommands(store);
    const text = () => store.getState().lines.map((l) => String(l.text).replace(/\x1b\[[0-9;]*m/g, "")).join("\n");
    return { run: (c) => tryHandleCommand(c, store), text };
  }

  it("/model test free refuses on a free-tier account", async () => {
    fm.setFreeFetchJson(async (url) => (url.endsWith("/key") ? { data: { is_free_tier: true } } : { data: [] }));
    const { run, text } = await setup();
    await run("/model test free");
    expect(text()).toMatch(/free tier.*50/i);
    fm.setFreeFetchJson(null);
  });

  it("/model test <id> runs in the background and reports the score", async () => {
    mc.setCheckAgentFactory(async ({ cwd }) => ({
      async ask(prompt) { const t = mc.CHECK_TASKS.find((x) => x.prompt === prompt); const r = act(t.id, cwd); return { ...r, usage: {} }; },
      async close() {},
    }));
    const { run, text } = await setup();
    await run("/model test some/model:free");
    await mc.lastCheckRun();
    expect(text()).toMatch(/some\/model:free\s+6\/6/);
    expect(mc.loadChecks()["some/model:free"].score).toBe(6);
    mc.setCheckAgentFactory(null);
  });
});
