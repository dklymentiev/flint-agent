// The stdio agent of the model check (src/model-check.js startStdioAgent):
// readiness, timers, and what it does with noise. A fake bin stands in for
// Flint (tests/helpers/fake-flint-bin.js); no model, no network.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const mc = await import("../../src/model-check.js");

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "helpers", "fake-flint-bin.js");
let dataDir;
let savedDataDir;
beforeAll(() => {
  savedDataDir = process.env.FLINT_DATA_DIR;
  dataDir = mkdtempSync(path.join(tmpdir(), "flint-check-agent-data-"));
  process.env.FLINT_DATA_DIR = dataDir;
});
afterAll(() => {
  if (savedDataDir === undefined) delete process.env.FLINT_DATA_DIR; else process.env.FLINT_DATA_DIR = savedDataDir;
  try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
});

const start = (env = {}, extra = {}) =>
  mc.startStdioAgent({ model: "x/y", cwd: tmpdir(), bin: FAKE, env, ...extra });
const timers = () => (process.getActiveResourcesInfo?.() || []).filter((r) => r === "Timeout").length;

describe("A1 readiness", () => {
  it("a slow cold start inside the limit succeeds and the first task is sent only after init", async () => {
    const agent = await start({ FAKE_INIT_DELAY_MS: "1500" }, { startupMs: 20000 });
    const t0 = Date.now();
    const r = await agent.ask("hi", { timeoutMs: 20000 });
    expect(r.answer).toBe("ready");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1000);   // it waited for init
    await agent.close();
  }, 30000);

  it("an agent that never reports ready rejects cleanly at the limit, not by throwing", async () => {
    const agent = await start({ FAKE_NEVER_INIT: "1" }, { startupMs: 700 });
    await expect(agent.ask("hi", { timeoutMs: 20000 })).rejects.toThrow(/did not start within/);
    await agent.close();
  }, 20000);

  it("an agent that exits before init rejects with that reason", async () => {
    const agent = await start({}, { bin: path.join(tmpdir(), "no-such-bin.js"), startupMs: 20000 });
    await expect(agent.ask("hi", { timeoutMs: 20000 })).rejects.toThrow(/exited|did not start/);
    await agent.close();
  }, 30000);

  it("leaves no timer behind once the agent is ready and closed", async () => {
    const before = timers();
    const agent = await start({}, { startupMs: 60000 });
    await agent.ask("hi", { timeoutMs: 60000 });
    await agent.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(timers()).toBeLessThanOrEqual(before);
  }, 30000);
});

describe("A2 what the agent reports for the current task", () => {
  it("a provider verdict on the result reaches the caller as providerError", async () => {
    const agent = await start({ FAKE_PROVIDER_ERROR: JSON.stringify({ status: 404, kind: "model-not-found" }) }, { startupMs: 20000 });
    const r = await agent.ask("hi", { timeoutMs: 20000 });
    expect(r.providerError).toEqual({ status: 404, kind: "model-not-found" });
    await agent.close();
  }, 30000);

  it("an unrelated 401 / 404 line on stderr is not a verdict: the task still completes", async () => {
    const agent = await start({ FAKE_STDERR_LINE: "proxy said 401 Unauthorized, then 404 Not Found, 403 Forbidden, retried ok" }, { startupMs: 20000 });
    const r = await agent.ask("hi", { timeoutMs: 20000 });
    expect(r.providerError).toBeUndefined();
    expect(r.answer).toBe("ready");
    await agent.close();
  }, 30000);
});
