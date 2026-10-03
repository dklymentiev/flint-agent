// Installing or reloading a plugin is asked, by default, even when an API
// caller's auto-approve has opened every other tool; config pluginInstall
// "allow" lets it through. A plugin is code that runs with the agent's rights.
import { describe, it, expect, vi, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "perm-plugin-"));
const sessionsDir = path.join(tmpBase, "sessions");
const cfg = { projectRoot: tmpBase, sessionsDir, pluginInstall: "ask" };

const mockExecuteTool = vi.fn(async (name) => `result:${name}`);

vi.mock("../../../src/config.js", () => ({ config: cfg }));
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
  return await import("../../../src/tools/permissions.js");
}

describe("plugin install gate", () => {
  it("an API run with everything auto-approved is still refused install_plugin by default", async () => {
    cfg.pluginInstall = "ask";
    const perms = await freshImport();
    perms.initPermissions({ confirm: vi.fn(async () => "yes") });
    perms.bulkSetPermission("allow");
    perms.setUnattended(true);
    const out = await perms.executeToolWithPermissions("install_plugin", { source: "x" });
    expect(out.denied).toBe(true);
    expect(out.result).toContain("no operator attached");
    expect(mockExecuteTool).not.toHaveBeenCalled();
  });

  it("an operator is asked for reload_plugins even when the tool is set to allow", async () => {
    cfg.pluginInstall = "ask";
    const perms = await freshImport();
    const confirm = vi.fn(async () => "yes");
    perms.initPermissions({ confirm });
    perms.bulkSetPermission("allow");
    const out = await perms.executeToolWithPermissions("reload_plugins", {});
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(out.denied).toBeFalsy();
  });

  it("pluginInstall allow lets an unattended run install", async () => {
    cfg.pluginInstall = "allow";
    const perms = await freshImport();
    perms.initPermissions({ confirm: vi.fn(async () => "no") });
    perms.bulkSetPermission("allow");
    perms.setUnattended(true);
    const out = await perms.executeToolWithPermissions("install_plugin", { source: "x" });
    expect(out.denied).toBeFalsy();
    expect(mockExecuteTool).toHaveBeenCalledWith("install_plugin", { source: "x" });
  });
});
