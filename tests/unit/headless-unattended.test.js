// A --headless run must never hold a confirmation
// prompt open, because there is nobody to answer it.
//
// This drives startHeadless() — the same function index.js calls on
// `cli.action === "headless"`. It does not restate the startup sequence: the
// point is that a test repeating index.js's block proves only its
// own copy and would stay green after the real block broke.
//
// The fingerprint of the defect: security.log recorded DENIED_TIMEOUT, the
// branch that races confirmFn against a 600 s timer, not DENIED_UNATTENDED,
// the branch that returns at once. So on a --headless run the unattended flag
// was never set: index.js called bulkSetPermission("allow"), which does not
// mark the run unattended, and the command guard's forced confirm fell through
// to the timer. 600 s in one run, over 20 min in another.
import { describe, it, expect, vi, beforeEach, afterAll, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "headless-unatt-"));

const mockExecuteTool = vi.fn(async (name) => `result:${name}`);

vi.mock("../../src/config.js", () => ({
  config: { projectRoot: tmpBase, sessionsDir: path.join(tmpBase, "sessions") },
}));

vi.mock("../../src/tools/registry.js", () => ({
  executeTool: (...args) => mockExecuteTool(...args),
}));

afterAll(() => {
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

const origCwd = process.cwd();

afterEach(() => {
  try { process.chdir(origCwd); } catch {}
});

async function freshModules() {
  vi.resetModules();
  mockExecuteTool.mockClear();
  const perms = await import("../../src/tools/permissions.js");
  perms.resetPermissionState();
  perms.resetSessionOverrides();
  try { fs.unlinkSync(path.join(tmpBase, ".permissions.json")); } catch {}
  try { fs.unlinkSync(path.join(tmpBase, "sessions", "security.log")); } catch {}
  return perms;
}

describe("--headless must not wait for a human", () => {
  beforeEach(() => { vi.resetModules(); });

  it("marks the run unattended", async () => {
    const perms = await freshModules();
    const { startHeadless } = await import("../../src/headless-start.js");

    // Exactly what index.js does for `flint --headless --task ...`.
    startHeadless({ cwd: tmpBase });

    expect(perms.isUnattended(),
      "the headless run was not marked unattended, so confirmations fall through to the 600s timer")
      .toBe(true);
  });

  it("denies a guarded command at once instead of waiting out the window", async () => {
    const perms = await freshModules();
    const { startHeadless } = await import("../../src/headless-start.js");

    // An operator who never answers.
    const confirm = vi.fn(() => new Promise(() => {}));
    perms.initPermissions({ confirm });
    // The command guard forces this one regardless of tool permissions.
    perms.addBeforeHook(() => ({ confirm: true, reason: "it is a destructive command" }));

    startHeadless({ cwd: tmpBase });

    const started = Date.now();
    const out = await perms.executeToolWithPermissions("run_command", { command: "rm -r ./tmp" });
    const elapsed = Date.now() - started;

    expect(out.denied).toBe(true);
    // The unattended branch says why; the timeout branch says "did not answer
    // within Ns", and that is the message the failing run logged.
    expect(out.result).toContain("no operator attached");
    expect(out.result).not.toMatch(/did not answer/i);
    expect(confirm).not.toHaveBeenCalled();
    expect(elapsed).toBeLessThan(1000);
    expect(mockExecuteTool).not.toHaveBeenCalled();
  });

  it("writes DENIED_UNATTENDED, not DENIED_TIMEOUT, to the security log", async () => {
    const perms = await freshModules();
    const { startHeadless } = await import("../../src/headless-start.js");

    const confirm = vi.fn(() => new Promise(() => {}));
    perms.initPermissions({ confirm });
    perms.addBeforeHook(() => ({ confirm: true, reason: "it is a destructive command" }));
    startHeadless({ cwd: tmpBase });

    await perms.executeToolWithPermissions("run_command", { command: "rm -r ./tmp" });

    let log = "";
    try { log = fs.readFileSync(path.join(tmpBase, "sessions", "security.log"), "utf8"); } catch {}
    expect(log, "no security.log entry was written").not.toBe("");
    expect(log).toContain("DENIED_UNATTENDED");
    expect(log, "the run is still logging the 600s timeout, not the unattended denial")
      .not.toContain("DENIED_TIMEOUT");
  });

  it("leaves a console run able to ask the operator", async () => {
    const perms = await freshModules();
    // The opposite direction matters as much: marking every run unattended would
    // turn every confirmation into an instant denial and the operator would
    // never see a prompt again.
    expect(perms.isUnattended(),
      "a fresh run is unattended before any startup ran")
      .toBe(false);
  });
});