import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Stable tmp dir for all tests
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "perm-test-"));
const sessionsDir = path.join(tmpBase, "sessions");

// Mock dependencies
const mockExecuteTool = vi.fn(async (name) => `result:${name}`);

vi.mock("../../../src/config.js", () => ({
  config: {
    projectRoot: tmpBase,
    sessionsDir,
  },
}));

vi.mock("../../../src/tools/registry.js", () => ({
  executeTool: (...args) => mockExecuteTool(...args),
}));

afterAll(() => {
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

// Fresh import after vi.resetModules() — clears module-level state
async function freshImport() {
  vi.resetModules();
  mockExecuteTool.mockClear();
  // Clean persisted files
  const permFile = path.join(tmpBase, ".permissions.json");
  try { fs.unlinkSync(permFile); } catch {}
  const secLog = path.join(sessionsDir, "security.log");
  try { fs.unlinkSync(secLog); } catch {}

  const mod = await import("../../../src/tools/permissions.js");
  // These tests exercise the confirm mechanics with the built-in defaults.
  // Since the care level also relaxes tool defaults (policies.js
  // toolPermissionAtLevel), they run at "safe", where every default holds.
  mod.saveOnboardingAnswer("safe");
  return mod;
}

// ── getPermission ──

describe("getPermission", () => {
  let mod;
  beforeEach(async () => { mod = await freshImport(); });

  it("returns 'allow' for read-only tools", () => {
    expect(mod.getPermission("read_file")).toBe("allow");
    expect(mod.getPermission("glob")).toBe("allow");
    expect(mod.getPermission("search_in_files")).toBe("allow");
    expect(mod.getPermission("think")).toBe("allow");
    expect(mod.getPermission("web_fetch")).toBe("allow");
  });

  it("returns 'confirm' for dangerous tools", () => {
    expect(mod.getPermission("write_file")).toBe("confirm");
    expect(mod.getPermission("run_command")).toBe("confirm");
    expect(mod.getPermission("delete_file")).toBe("confirm");
    expect(mod.getPermission("kill_process")).toBe("confirm");
  });

  it("returns 'confirm' for unknown tools", () => {
    expect(mod.getPermission("totally_unknown_tool")).toBe("confirm");
  });
});

// ── setPermission / overrides ──

describe("setPermission", () => {
  let mod;
  beforeEach(async () => { mod = await freshImport(); });

  it("overrides default level", () => {
    mod.setPermission("write_file", "allow");
    expect(mod.getPermission("write_file")).toBe("allow");
  });

  it("can deny a normally-allowed tool", () => {
    mod.setPermission("read_file", "deny");
    expect(mod.getPermission("read_file")).toBe("deny");
  });

  it("persists to .permissions.json", () => {
    mod.setPermission("run_command", "deny");
    const file = path.join(tmpBase, ".permissions.json");
    expect(fs.existsSync(file)).toBe(true);
    const data = JSON.parse(fs.readFileSync(file, "utf-8"));
    expect(data.run_command).toBe("deny");
  });
});

// ── getPermissionMap ──

describe("getPermissionMap", () => {
  let mod;
  beforeEach(async () => { mod = await freshImport(); });

  it("includes all default tools", () => {
    const map = mod.getPermissionMap();
    expect(map.read_file).toBe("allow");
    expect(map.write_file).toBe("confirm");
    expect(map.run_command).toBe("confirm");
    expect(map.think).toBe("allow");
  });

  it("reflects overrides", () => {
    mod.setPermission("write_file", "deny");
    const map = mod.getPermissionMap();
    expect(map.write_file).toBe("deny");
  });
});

// ── resetSessionOverrides ──

describe("resetSessionOverrides", () => {
  let mod;
  beforeEach(async () => { mod = await freshImport(); });

  it("clears all overrides to defaults", () => {
    mod.setPermission("write_file", "allow");
    mod.setPermission("read_file", "deny");
    mod.resetSessionOverrides();
    expect(mod.getPermission("write_file")).toBe("confirm");
    expect(mod.getPermission("read_file")).toBe("allow");
  });

  it("clears .permissions.json", () => {
    mod.setPermission("write_file", "deny");
    mod.resetSessionOverrides();
    const file = path.join(tmpBase, ".permissions.json");
    const data = JSON.parse(fs.readFileSync(file, "utf-8"));
    // Tool overrides are gone; the care level is not a tool override and stays.
    expect(Object.keys(data)).toEqual(["onboardingAnswer"]);
  });

  it("keeps the care level, so the onboarding question does not come back", () => {
    mod.saveOnboardingAnswer("permissive");
    mod.setPermission("write_file", "deny");
    mod.resetSessionOverrides();
    expect(mod.getOnboardingAnswer()).toBe("permissive");
    expect(mod.getPermission("write_file")).toBe("allow");
  });
});

// ── bulkSetPermission ──

describe("bulkSetPermission", () => {
  let mod;
  beforeEach(async () => { mod = await freshImport(); });

  it("sets all tools to allow", () => {
    mod.bulkSetPermission("allow");
    expect(mod.getPermission("write_file")).toBe("allow");
    expect(mod.getPermission("run_command")).toBe("allow");
    expect(mod.getPermission("delete_file")).toBe("allow");
  });

  it("sets all tools to deny", () => {
    mod.bulkSetPermission("deny");
    expect(mod.getPermission("read_file")).toBe("deny");
    expect(mod.getPermission("think")).toBe("deny");
  });
});

// ── Persistence: load from disk ──

describe("persistence", () => {
  it("loads overrides from .permissions.json on import", async () => {
    // Write a permissions file BEFORE importing the module
    const permFile = path.join(tmpBase, ".permissions.json");
    fs.writeFileSync(permFile, JSON.stringify({ run_command: "deny" }));

    vi.resetModules();
    const mod = await import("../../../src/tools/permissions.js");
    expect(mod.getPermission("run_command")).toBe("deny");
  });
});

// ── executeToolWithPermissions — allow ──

describe("executeToolWithPermissions — allow path", () => {
  let mod;
  beforeEach(async () => { mod = await freshImport(); });

  it("executes allowed tool without confirmation", async () => {
    const confirmFn = vi.fn();
    mod.initPermissions({ confirm: confirmFn });

    const { result, denied } = await mod.executeToolWithPermissions("read_file", { path: "a.txt" });
    expect(denied).toBe(false);
    expect(result).toBe("result:read_file");
    expect(confirmFn).not.toHaveBeenCalled();
    expect(mockExecuteTool).toHaveBeenCalledWith("read_file", { path: "a.txt" });
  });
});

// ── executeToolWithPermissions — confirm ──

describe("executeToolWithPermissions — confirm path", () => {
  let mod;
  beforeEach(async () => { mod = await freshImport(); });

  it("calls confirmFn and executes on 'yes'", async () => {
    const confirmFn = vi.fn(async () => "yes");
    mod.initPermissions({ confirm: confirmFn });

    const { result, denied } = await mod.executeToolWithPermissions("write_file", { path: "b.txt", content: "hi" });
    expect(denied).toBe(false);
    expect(result).toBe("result:write_file");
    // Third argument says why the prompt appeared and what "always" grants.
    expect(confirmFn).toHaveBeenCalledWith(
      "write_file",
      { path: "b.txt", content: "hi" },
      { reason: null, scope: "always allow write_file", key: null },
    );
  });

  it("denies on 'no'", async () => {
    const confirmFn = vi.fn(async () => "no");
    mod.initPermissions({ confirm: confirmFn });

    const { result, denied } = await mod.executeToolWithPermissions("write_file", {});
    expect(denied).toBe(true);
    expect(result).toContain("denied by the operator");
    expect(mockExecuteTool).not.toHaveBeenCalled();
  });

  it("'always' executes and sets override to allow", async () => {
    const confirmFn = vi.fn(async () => "always");
    mod.initPermissions({ confirm: confirmFn });

    const { denied } = await mod.executeToolWithPermissions("write_file", {});
    expect(denied).toBe(false);
    expect(mod.getPermission("write_file")).toBe("allow");

    // Second call should NOT trigger confirm
    confirmFn.mockClear();
    await mod.executeToolWithPermissions("write_file", {});
    expect(confirmFn).not.toHaveBeenCalled();
  });
});

// ── executeToolWithPermissions — deny ──

describe("executeToolWithPermissions — deny path", () => {
  let mod;
  beforeEach(async () => { mod = await freshImport(); });

  it("denies immediately without calling executeTool", async () => {
    mod.setPermission("run_command", "deny");
    mod.initPermissions({ confirm: vi.fn() });

    const { result, denied } = await mod.executeToolWithPermissions("run_command", { cmd: "rm -rf /" });
    expect(denied).toBe(true);
    expect(result).toContain("denied");
    expect(mockExecuteTool).not.toHaveBeenCalled();
  });

  it("writes to security.log on deny", async () => {
    mod.setPermission("run_command", "deny");
    mod.initPermissions({ confirm: vi.fn() });

    await mod.executeToolWithPermissions("run_command", { cmd: "whoami" });
    const logFile = path.join(sessionsDir, "security.log");
    expect(fs.existsSync(logFile)).toBe(true);
    const content = fs.readFileSync(logFile, "utf-8");
    expect(content).toContain("DENIED_RULE");
    expect(content).toContain("run_command");
  });
});

// ── Timeout ──

describe("executeToolWithPermissions — timeout", () => {
  let mod;
  beforeEach(async () => { mod = await freshImport(); });

  it("auto-denies after timeout", async () => {
    // confirmFn that never resolves
    const confirmFn = () => new Promise(() => {});
    mod.initPermissions({ confirm: confirmFn, timeout: 100 }); // 100ms timeout

    const { result, denied } = await mod.executeToolWithPermissions("write_file", {});
    expect(denied).toBe(true);
    // The old text was a bare "auto-denied (timeout)"; the model has to be
    // able to tell an unanswered prompt from a broken tool.
    expect(result).toContain("did not answer the approval prompt");
    expect(result).toContain("100ms");
  });

  it("writes timeout to security.log", async () => {
    const confirmFn = () => new Promise(() => {});
    mod.initPermissions({ confirm: confirmFn, timeout: 100 });

    await mod.executeToolWithPermissions("edit_file", { path: "x.js" });
    const logFile = path.join(sessionsDir, "security.log");
    const content = fs.readFileSync(logFile, "utf-8");
    expect(content).toContain("DENIED_TIMEOUT");
    expect(content).toContain("edit_file");
  });
});

// ── Before hooks ──

describe("beforeHooks", () => {
  let mod;
  beforeEach(async () => { mod = await freshImport(); });

  it("deny hook blocks execution", async () => {
    mod.initPermissions({ confirm: vi.fn() });
    mod.addBeforeHook(() => ({ deny: true, reason: "forbidden zone" }));

    const { result, denied } = await mod.executeToolWithPermissions("read_file", {});
    expect(denied).toBe(true);
    expect(result).toContain("forbidden zone");
    expect(mockExecuteTool).not.toHaveBeenCalled();
  });

  it("allow hook skips confirm for confirm-level tool", async () => {
    const confirmFn = vi.fn();
    mod.initPermissions({ confirm: confirmFn });
    mod.addBeforeHook((name) => name === "write_file" ? { allow: true } : null);

    const { denied } = await mod.executeToolWithPermissions("write_file", {});
    expect(denied).toBe(false);
    expect(confirmFn).not.toHaveBeenCalled();
    expect(mockExecuteTool).toHaveBeenCalled();
  });

  it("null verdict passes through to next hook or default logic", async () => {
    const confirmFn = vi.fn(async () => "yes");
    mod.initPermissions({ confirm: confirmFn });
    mod.addBeforeHook(() => null);

    const { denied } = await mod.executeToolWithPermissions("write_file", {});
    expect(denied).toBe(false);
    expect(confirmFn).toHaveBeenCalled();
  });

  it("propagates denyKey from hook verdict", async () => {
    mod.initPermissions({ confirm: vi.fn() });
    mod.addBeforeHook(() => ({ deny: true, reason: "blocked", denyKey: "cmd:test-pattern" }));

    const { result, denied, denyKey } = await mod.executeToolWithPermissions("run_command", {});
    expect(denied).toBe(true);
    expect(denyKey).toBe("cmd:test-pattern");
  });

  it("returns null denyKey when hook does not provide one", async () => {
    mod.initPermissions({ confirm: vi.fn() });
    mod.addBeforeHook(() => ({ deny: true, reason: "blocked" }));

    const { denied, denyKey } = await mod.executeToolWithPermissions("run_command", {});
    expect(denied).toBe(true);
    expect(denyKey).toBeNull();
  });
});

// ── After hooks ──

describe("afterHooks", () => {
  let mod;
  beforeEach(async () => { mod = await freshImport(); });

  it("transforms tool result", async () => {
    mod.initPermissions({ confirm: vi.fn() });
    mod.addAfterHook((name, args, result) => result + " [modified]");

    const { result } = await mod.executeToolWithPermissions("read_file", {});
    expect(result).toBe("result:read_file [modified]");
  });

  it("null return preserves original result", async () => {
    mod.initPermissions({ confirm: vi.fn() });
    mod.addAfterHook(() => null);

    const { result } = await mod.executeToolWithPermissions("read_file", {});
    expect(result).toBe("result:read_file");
  });
});

// ── Security log for user deny ──

describe("security log", () => {
  let mod;
  beforeEach(async () => { mod = await freshImport(); });

  it("logs user deny", async () => {
    mod.initPermissions({ confirm: async () => "no" });
    await mod.executeToolWithPermissions("delete_file", { path: "/etc/passwd" });

    const logFile = path.join(sessionsDir, "security.log");
    const content = fs.readFileSync(logFile, "utf-8");
    expect(content).toContain("DENIED_USER");
    expect(content).toContain("delete_file");
    expect(content).toContain("/etc/passwd");
  });

  it("logs hook deny", async () => {
    mod.initPermissions({ confirm: vi.fn() });
    mod.addBeforeHook(() => ({ deny: true, reason: "nope" }));
    await mod.executeToolWithPermissions("run_command", { cmd: "rm -rf" });

    const logFile = path.join(sessionsDir, "security.log");
    const content = fs.readFileSync(logFile, "utf-8");
    expect(content).toContain("DENIED_HOOK");
    expect(content).toContain("nope");
  });
});

// ── Per-file approvals ──
//
// The operator presses [a]lways on a secret file and is asked again on the
// very next call, forever. The answer was written as a tool-wide "allow" that
// the forced-confirm branch never reads.

describe("forced confirm on a secret file", () => {
  let mod;
  const SECRET = path.join(tmpBase, ".env");
  const OTHER_SECRET = path.join(tmpBase, "sub", "credentials.json");

  // Stands in for the real path-guard: forces confirmation on a secret file
  // and offers the key that an "always" answer may be recorded under.
  function secretHook() {
    return (name, args) => {
      if (!args || !args.path) return null;
      if (![SECRET, OTHER_SECRET].includes(args.path)) return null;
      return {
        confirm: true,
        reason: `"${path.basename(args.path)}" matches the secret-file patterns`,
        key: `${name}:${args.path}`,
      };
    };
  }

  beforeEach(async () => { mod = await freshImport(); });

  it("stops asking after [a]lways for that file", async () => {
    const confirm = vi.fn(async () => "always");
    mod.initPermissions({ confirm });
    mod.addBeforeHook(secretHook());

    const first = await mod.executeToolWithPermissions("read_file", { path: SECRET });
    const second = await mod.executeToolWithPermissions("read_file", { path: SECRET });

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(first.denied).toBe(false);
    expect(second.denied).toBe(false);
    expect(second.result).toBe("result:read_file");
  });

  it("keeps the grant narrow: another secret file still asks", async () => {
    const confirm = vi.fn(async () => "always");
    mod.initPermissions({ confirm });
    mod.addBeforeHook(secretHook());

    await mod.executeToolWithPermissions("read_file", { path: SECRET });
    await mod.executeToolWithPermissions("read_file", { path: OTHER_SECRET });

    expect(confirm).toHaveBeenCalledTimes(2);
    expect(Object.keys(mod.getApprovedPaths())).toEqual([
      `read_file:${SECRET}`,
      `read_file:${OTHER_SECRET}`,
    ]);
  });

  it("does not turn the whole tool into 'allow'", async () => {
    mod.initPermissions({ confirm: async () => "always" });
    mod.addBeforeHook(secretHook());
    await mod.executeToolWithPermissions("write_file", { path: SECRET });
    // The file is approved; write_file as such must still be a confirm tool.
    expect(mod.getPermission("write_file")).toBe("confirm");
  });

  it("survives a restart", async () => {
    mod.initPermissions({ confirm: async () => "always" });
    mod.addBeforeHook(secretHook());
    await mod.executeToolWithPermissions("read_file", { path: SECRET });

    const onDisk = JSON.parse(fs.readFileSync(path.join(tmpBase, ".permissions.json"), "utf-8"));
    expect(onDisk._approvedPaths[`read_file:${SECRET}`]).toBe(true);

    // Reload the module WITHOUT wiping the file — as a restart would.
    vi.resetModules();
    const reloaded = await import("../../../src/tools/permissions.js");
    const confirm = vi.fn(async () => "no");
    reloaded.initPermissions({ confirm });
    reloaded.addBeforeHook(secretHook());
    const r = await reloaded.executeToolWithPermissions("read_file", { path: SECRET });

    expect(confirm).not.toHaveBeenCalled();
    expect(r.denied).toBe(false);
    // _approvedPaths must not be mistaken for a tool named "_approvedPaths".
    expect(reloaded.getPermissionMap()._approvedPaths).toBeUndefined();
  });

  it("an ordinary confirm with no key still sets the tool level", async () => {
    mod.initPermissions({ confirm: async () => "always" });
    await mod.executeToolWithPermissions("delete_file", { path: "/tmp/x" });
    expect(mod.getPermission("delete_file")).toBe("allow");
  });

  it("revoking brings the prompt back", async () => {
    const confirm = vi.fn(async () => "always");
    mod.initPermissions({ confirm });
    mod.addBeforeHook(secretHook());
    await mod.executeToolWithPermissions("read_file", { path: SECRET });
    expect(mod.revokeApprovedPath(`read_file:${SECRET}`)).toBe(true);
    await mod.executeToolWithPermissions("read_file", { path: SECRET });
    expect(confirm).toHaveBeenCalledTimes(2);
  });
});

// ── The refusal has to say why ──
//
// A bare "auto-denied (timeout)" cost ~15 of 26 iterations on 2026-09-19:
// the model read it as "the file is too large" and invented workarounds.

describe("refusal text", () => {
  let mod;
  beforeEach(async () => { mod = await freshImport(); });

  it("hands the reason to the confirm prompt", async () => {
    const confirm = vi.fn(async () => "yes");
    mod.initPermissions({ confirm });
    mod.addBeforeHook(() => ({ confirm: true, reason: "it may hold credentials", key: "read_file:/x/.env" }));
    await mod.executeToolWithPermissions("read_file", { path: "/x/.env" });

    const meta = confirm.mock.calls[0][2];
    expect(meta.reason).toBe("it may hold credentials");
    expect(meta.scope).toContain("this path only");
  });

  it("tells the model why it was denied, not just that it was", async () => {
    mod.initPermissions({ confirm: async () => "no" });
    mod.addBeforeHook(() => ({ confirm: true, reason: "it may hold credentials", key: "read_file:/x/.env" }));
    const r = await mod.executeToolWithPermissions("read_file", { path: "/x/.env" });

    expect(r.denied).toBe(true);
    expect(r.result).toContain("denied by the operator");
    expect(r.result).toContain("it may hold credentials");
    expect(r.result).toContain("Do not retry");
  });

  it("names the window and the reason on timeout", async () => {
    mod.initPermissions({ confirm: () => new Promise(() => {}), timeout: 20 });
    mod.addBeforeHook(() => ({ confirm: true, reason: "it may hold credentials", key: "read_file:/x/.env" }));
    const r = await mod.executeToolWithPermissions("read_file", { path: "/x/.env" });

    expect(r.denied).toBe(true);
    expect(r.result).toContain("did not answer");
    expect(r.result).toContain("it may hold credentials");
    expect(r.result).not.toContain("auto-denied (timeout)");
  });

  it("reports the real confirm window", async () => {
    // The UI used to print a hardcoded "30s" next to a layer that was
    // documented as 600s. One source of truth now.
    expect(mod.getConfirmTimeoutMs()).toBe(600000);
    mod.initPermissions({ confirm: async () => "yes", timeout: 1234 });
    expect(mod.getConfirmTimeoutMs()).toBe(1234);
  });
});
