// An approval prompt in a run with nobody behind it must fail fast, not hold
// the bus for the full confirm window. The bus is serial, so a 10-minute wait
// on an unanswerable question stalls every message queued behind it.
import { describe, it, expect, vi, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "perm-unattended-"));
const sessionsDir = path.join(tmpBase, "sessions");

const mockExecuteTool = vi.fn(async (name) => `result:${name}`);

vi.mock("../../../src/config.js", () => ({
  config: { projectRoot: tmpBase, sessionsDir },
}));

vi.mock("../../../src/tools/registry.js", () => ({
  executeTool: (...args) => mockExecuteTool(...args),
}));

afterAll(() => {
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

async function freshImport() {
  vi.resetModules();
  mockExecuteTool.mockClear();
  try { fs.unlinkSync(path.join(tmpBase, ".permissions.json")); } catch {}
  try { fs.unlinkSync(path.join(sessionsDir, "security.log")); } catch {}
  return await import("../../../src/tools/permissions.js");
}

describe("approval prompts in an unattended run", () => {
  it("denies at once instead of waiting out the confirm window", async () => {
    const perms = await freshImport();

    // An operator who never answers. Before the fix this promise is raced
    // against confirmTimeoutMs (600s), so the call simply never returns and
    // the test dies on vitest's own timeout.
    const confirm = vi.fn(() => new Promise(() => {}));
    perms.initPermissions({ confirm });
    perms.addBeforeHook(() => ({ confirm: true, reason: "it is a dangerous command" }));
    perms.setUnattended(true);

    const started = Date.now();
    const out = await perms.executeToolWithPermissions("run_command", { command: "rm -rf ./tmp" });
    const elapsed = Date.now() - started;

    expect(out.denied).toBe(true);
    expect(out.result).toContain("no operator attached");
    expect(out.result).toContain("it is a dangerous command");
    expect(out.result).toMatch(/do not retry/i);
    expect(confirm).not.toHaveBeenCalled();
    expect(elapsed).toBeLessThan(1000);
    expect(mockExecuteTool).not.toHaveBeenCalled();
  });

  it("still asks when an operator is attached", async () => {
    const perms = await freshImport();

    const confirm = vi.fn(async () => "yes");
    perms.initPermissions({ confirm });
    perms.addBeforeHook(() => ({ confirm: true, reason: "it is a dangerous command" }));
    perms.setUnattended(false);

    const out = await perms.executeToolWithPermissions("run_command", { command: "ls" });

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(out.denied).toBeFalsy();
    expect(mockExecuteTool).toHaveBeenCalled();
  });

  it("writes the pid into the security log so a denial can be attributed", async () => {
    const perms = await freshImport();

    perms.initPermissions({ confirm: vi.fn(() => new Promise(() => {})) });
    perms.addBeforeHook(() => ({ deny: true, reason: "dangerous command blocked" }));

    await perms.executeToolWithPermissions("run_command", { command: "rm -rf /" });

    const log = fs.readFileSync(path.join(sessionsDir, "security.log"), "utf-8");
    expect(log).toContain(`[pid ${process.pid}]`);
    expect(log).toContain("DENIED_HOOK");
  });
});
