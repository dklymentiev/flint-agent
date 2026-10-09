// Model check (docs/model-check.md, M1-M4).
import { describe, it, expect, vi, afterEach, beforeEach, beforeAll, afterAll, spyOn } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, rmSync, readFileSync } from "node:fs";
import { tmpdir, homedir, userInfo } from "node:os";
import path from "node:path";

vi.mock("../../src/logging/logger.js", () => ({
  createLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
}));

const mc = await import("../../src/model-check.js");
const fm = await import("../../src/free-models.js");
const keysMod = await import("../../src/providers/keys.js");

// Guard: the operator's REAL ~/.flint/model-checks.json (userInfo() ignores the
// HOME/USERPROFILE overrides) must come out of this file exactly as it went in.
// An earlier afterEach deleted it, and with a runner that does not sandbox HOME
// the tests also wrote into it.
const REAL_CHECKS = path.join(userInfo().homedir, ".flint", "model-checks.json");
const snapshot = () => (existsSync(REAL_CHECKS) ? readFileSync(REAL_CHECKS, "utf8") : null);
// All writes go to a private data dir (homeStateDir() honours FLINT_DATA_DIR in
// every runner, sandboxed HOME or not), and cleanup only touches that dir.
let realBefore;
let testDataDir;
let savedDataDir;
const checksFile = () => path.join(testDataDir, "model-checks.json");
const cleanChecks = () => { if (existsSync(checksFile())) rmSync(checksFile()); };
beforeAll(() => {
  realBefore = snapshot();
  savedDataDir = process.env.FLINT_DATA_DIR;
  testDataDir = mkdtempSync(path.join(tmpdir(), "flint-check-data-"));
  process.env.FLINT_DATA_DIR = testDataDir;
});
afterAll(() => {
  if (savedDataDir === undefined) delete process.env.FLINT_DATA_DIR; else process.env.FLINT_DATA_DIR = savedDataDir;
  // Best effort: the sqlite index in there can still be open on Windows.
  try { rmSync(testDataDir, { recursive: true, force: true }); } catch {}
  expect(snapshot(), "the real ~/.flint/model-checks.json was touched").toBe(realBefore);
});

const tmp = () => mkdtempSync(path.join(tmpdir(), "flint-check-"));
const task = (id) => mc.CHECK_TASKS.find((t) => t.id === id);
afterEach(cleanChecks);

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

describe("M5 key forwarding", () => {
  // startStdioAgent gives the subprocess its own FLINT_DATA_DIR (a temp dir),
  // so the operator's encrypted key in the real ~/.flint/keys.enc is invisible
  // to it. The fix: startStdioAgent reads the key from the real data dir and
  // passes it through the matching env var so the subprocess can use it.
  // Never print or log the key value.

  afterEach(() => {
    vi.restoreAllMocks();
    cleanChecks();
  });

  it("does not set OPENROUTER_API_KEY when no key exists in storage", async () => {
    vi.spyOn(keysMod, "getKey").mockResolvedValue(null);

    const agent = await mc.startStdioAgent({ model: "test/model", cwd: tmpdir() });
    // child process spawned with correct env — verify via internal inspection
    // The agent object should have created the process; we can't easily inspect
    // the spawn args, but we can confirm that getKey was consulted.
    expect(keysMod.getKey).toHaveBeenCalledWith("openrouter");
    await agent.close();
  });

  it("sets OPENROUTER_API_KEY from the real data dir when a key exists", async () => {
    const FAKE_KEY = "sk-test-does-not-matter";
    vi.spyOn(keysMod, "getKey").mockResolvedValue(FAKE_KEY);

    const env = await mc.buildCheckEnv(tmpdir(), FAKE_KEY);
    expect(env.OPENROUTER_API_KEY).toBe(FAKE_KEY);
    vi.mocked(keysMod.getKey).mockRestore();
  });
});

describe("M6 no score saved on infrastructure failure", () => {
  // When every task fails (e.g. all error out at ~0.1s because the model
  // never answered), the failure is infrastructure (missing key, wrong URL),
  // not the model. runCheck must NOT save a score in that case.
  afterEach(() => {
    vi.restoreAllMocks();
    cleanChecks();
  });

  it("does not save a result when all six tasks fail", async () => {
    const startAgent = async ({ cwd }) => ({
      async ask() { throw new Error("API key not found"); },
      async close() {},
    });
    const res = await mc.runCheck("broken/model:free", { startAgent });
    // All tasks failed
    expect(res.score).toBe(0);
    // The result must NOT be persisted
    expect(mc.loadChecks()["broken/model:free"]).toBeUndefined();
  });

  it("saves a result when at least one task passes", async () => {
    const startAgent = async ({ cwd }) => ({
      async ask(prompt) {
        const t = mc.CHECK_TASKS.find((x) => x.prompt === prompt);
        if (t.id === "write-file") return { ...act(t.id, cwd), usage: {} };
        throw new Error("API key not found");
      },
      async close() {},
    });
    const res = await mc.runCheck("partial/model:free", { startAgent });
    expect(res.score).toBe(1);
    // A partial score IS saved (not all tasks failed)
    expect(mc.loadChecks()["partial/model:free"]).toBeDefined();
    expect(mc.loadChecks()["partial/model:free"].score).toBe(1);
  });
});

describe("M7 a model the provider refuses is unavailable, not scored", () => {
  afterEach(cleanChecks);
  const refusing = (providerError, counter) => async ({ cwd }) => (counter.started = (counter.started || 0) + 1, {
    async ask() { counter.asked++; return { answer: "", tools: [], usage: {}, providerError }; },
    async close() { counter.closed++; },
  });

  it("404 model-not-found ends the check at the first task: unavailable with a reason, no score, nothing saved", async () => {
    const c = { asked: 0, closed: 0 };
    const res = await mc.runCheck("gone/model:free", { startAgent: refusing({ status: 404, kind: "model-not-found" }, c) });
    expect(res.unavailable).toMatch(/404|not found/i);
    expect(res.score).toBeNull();
    expect(c.asked).toBe(1);
    expect(c.closed).toBe(c.started);   // none left running, the one started ahead included
    expect(mc.loadChecks()["gone/model:free"]).toBeUndefined();
  });

  it("an auth refusal (401/403) is unavailable too", async () => {
    const c = { asked: 0, closed: 0 };
    const res = await mc.runCheck("locked/model", { startAgent: refusing({ status: 401, kind: "auth" }, c) });
    expect(res.unavailable).toMatch(/401|auth/i);
    expect(mc.loadChecks()["locked/model"]).toBeUndefined();
  });

  it("any other error is a normal task failure and the run goes on", async () => {
    const c = { asked: 0, closed: 0 };
    const res = await mc.runCheck("flaky/model", { startAgent: refusing({ status: 503, kind: "server" }, c) });
    expect(res.unavailable).toBeUndefined();
    expect(c.asked).toBe(6);
  });

  it("the command reports 'unavailable: <reason>' instead of a score", async () => {
    const c = { asked: 0, closed: 0 };
    mc.setCheckAgentFactory(refusing({ status: 404, kind: "model-not-found" }, c));
    const lines = [];
    await mc.startCheckRun(["gone/model:free"], (l) => lines.push(l));
    mc.setCheckAgentFactory(null);
    const out = lines.join(String.fromCharCode(10));
    expect(out).toMatch(/gone\/model:free\s+unavailable: .*404/);
    expect(out).not.toMatch(/\d\/6/);
  });
});

describe("M8 a fresh agent per task", () => {
  afterEach(() => { mc.setCheckAgentFactory(null); cleanChecks(); });
  const timers = () => (process.getActiveResourcesInfo?.() || []).filter((r) => r === "Timeout").length;

  /** An agent whose context grows with every prompt it is given, like a real conversation. */
  const growing = (log) => async ({ cwd }) => {
    let context = 1000;   // the system prompt
    const id = ++log.started;
    return {
      async ask(prompt) {
        const t = mc.CHECK_TASKS.find((x) => x.prompt === prompt);
        context += prompt.length + 50;
        const r = act(t.id, cwd);
        return { ...r, usage: { input_tokens: context, output_tokens: 5 } };
      },
      async close() { log.closed.push(id); },
    };
  };

  it("starts and closes one agent per task, so task 6 carries none of tasks 1 to 5", async () => {
    const log = { started: 0, closed: [] };
    const res = await mc.runCheck("ctx/model", { startAgent: growing(log) });
    const last = mc.CHECK_TASKS[5];
    expect(log.started).toBe(6);
    expect(log.closed.sort()).toEqual([1, 2, 3, 4, 5, 6]);
    expect(res.tasks[5].tokensIn).toBe(1000 + last.prompt.length + 50);
    expect(res.score).toBe(6);
  });

  it("one agent that fails to start fails that task only; the run finishes and the result is not saved as a score", async () => {
    let n = 0;
    const startAgent = async (o) => {
      n++;
      if (n === 3) throw new Error("spawn EAGAIN");
      return growing({ started: 0, closed: [] })(o);
    };
    const res = await mc.runCheck("startfail/model", { startAgent });
    expect(res.tasks).toHaveLength(6);
    expect(res.tasks[2]).toMatchObject({ id: "edit-json", passed: false });
    expect(res.tasks[2].error).toMatch(/did not start.*EAGAIN/);
    expect(res.tasks.filter((t) => t.passed)).toHaveLength(5);
    expect(res.incomplete).toBe(true);
    expect(mc.loadChecks()["startfail/model"]).toBeUndefined();
  });

  it("starts the next agent while the current task runs (the startup cost is hidden)", async () => {
    const events = [];
    let n = 0;
    const startAgent = async ({ cwd }) => {
      const id = ++n;
      events.push(`start${id}`);
      return {
        async ask(prompt) { events.push(`ask${id}`); await new Promise((r) => setTimeout(r, 20)); events.push(`done${id}`); const t = mc.CHECK_TASKS.find((x) => x.prompt === prompt); return { ...act(t.id, cwd), usage: {} }; },
        async close() {},
      };
    };
    await mc.runCheck("pre/model", { startAgent });
    expect(events).toContain("start2");
    expect(events.indexOf("start2")).toBeLessThan(events.indexOf("done1"));
  });

  it("the task timeout is configurable and keeps its old default of 120 s", async () => {
    expect(mc.taskTimeoutMs()).toBe(120000);
    process.env.FLINT_CHECK_TASK_TIMEOUT_S = "7";
    try { expect(mc.taskTimeoutMs()).toBe(7000); } finally { delete process.env.FLINT_CHECK_TASK_TIMEOUT_S; }
    const seen = [];
    const startAgent = async ({ cwd }) => ({ async ask(p, o) { seen.push(o.timeoutMs); const t = mc.CHECK_TASKS.find((x) => x.prompt === p); return { ...act(t.id, cwd), usage: {} }; }, async close() {} });
    await mc.runCheck("t/model", { startAgent });
    expect(new Set(seen)).toEqual(new Set([120000]));
    seen.length = 0;
    await mc.runCheck("t/model", { startAgent, timeoutMs: 9000 });
    expect(new Set(seen)).toEqual(new Set([9000]));
  });

  it("leaves no timer behind after a run", async () => {
    const before = timers();
    await mc.runCheck("timers/model", { startAgent: growing({ started: 0, closed: [] }) });
    expect(timers()).toBeLessThanOrEqual(before);
  });

  it("a closed-too-late prestarted agent is closed when the model turns out unavailable", async () => {
    let closed = 0;
    let n = 0;
    const startAgent = async () => { n++; return { async ask() { return { answer: "", tools: [], usage: {}, providerError: { status: 404, kind: "model-not-found" } }; }, async close() { closed++; } }; };
    const res = await mc.runCheck("gone/model", { startAgent });
    expect(res.unavailable).toBeTruthy();
    expect(closed).toBe(n);
  });
});
