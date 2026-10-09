// A headless run has nobody to ask. The operator who started it already chose
// which MCP servers it has (the launch config names them), so a tool of one of
// those servers runs without a prompt. Anything that was FORCED to confirm
// (a dangerous command, a secret file, a plugin) and anything the operator set
// to confirm or deny by rule is still refused, because that answer was explicit.
import { describe, it, expect, vi, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "perm-unattended-mcp-"));
const sessionsDir = path.join(tmpBase, "sessions");
const mockConfig = { projectRoot: tmpBase, sessionsDir };
const mockExecuteTool = vi.fn(async (name) => `result:${name}`);

vi.mock("../../../src/config.js", () => ({ config: mockConfig }));
vi.mock("../../../src/tools/registry.js", () => ({
  executeTool: (...args) => mockExecuteTool(...args),
}));

afterAll(() => {
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

async function fresh() {
  vi.resetModules();
  mockExecuteTool.mockClear();
  delete mockConfig.headlessMcp;
  try { fs.unlinkSync(path.join(tmpBase, ".permissions.json")); } catch {}
  try { fs.unlinkSync(path.join(sessionsDir, "security.log")); } catch {}
  const perms = await import("../../../src/tools/permissions.js");
  const servers = await import("../../../src/tools/mcp-tool-servers.js");
  servers.noteMcpTool("mcp_notes_get", "notes");
  return perms;
}

describe("MCP tools in an unattended run", () => {
  it("run without a prompt", async () => {
    const perms = await fresh();
    const confirm = vi.fn(() => new Promise(() => {}));
    perms.initPermissions({ confirm });
    perms.setUnattended(true);
    const out = await perms.executeToolWithPermissions("mcp_notes_get", { guid: "x" });
    expect(out.denied).toBeFalsy();
    expect(confirm).not.toHaveBeenCalled();
    expect(mockExecuteTool).toHaveBeenCalledTimes(1);
  });

  it("still ask an operator who is attached", async () => {
    const perms = await fresh();
    const confirm = vi.fn(async () => "yes");
    perms.initPermissions({ confirm });
    perms.setUnattended(false);
    await perms.executeToolWithPermissions("mcp_notes_get", { guid: "x" });
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it("are refused when the operator set the tool to confirm by rule", async () => {
    const perms = await fresh();
    perms.initPermissions({ confirm: vi.fn() });
    perms.setPermission("mcp_notes_get", "confirm");
    perms.setUnattended(true);
    const out = await perms.executeToolWithPermissions("mcp_notes_get", { guid: "x" });
    expect(out.denied).toBe(true);
    expect(out.result).toContain("no operator attached");
  });

  it("are refused when a guard forced a confirmation", async () => {
    const perms = await fresh();
    perms.initPermissions({ confirm: vi.fn() });
    perms.addBeforeHook(() => ({ confirm: true, reason: "it sends mail to everyone" }));
    perms.setUnattended(true);
    const out = await perms.executeToolWithPermissions("mcp_notes_get", { guid: "x" });
    expect(out.denied).toBe(true);
    expect(out.result).toContain("it sends mail to everyone");
  });

  it("are refused again when the setting is ask", async () => {
    const perms = await fresh();
    mockConfig.headlessMcp = "ask";
    perms.initPermissions({ confirm: vi.fn() });
    perms.setUnattended(true);
    const out = await perms.executeToolWithPermissions("mcp_notes_get", { guid: "x" });
    expect(out.denied).toBe(true);
  });

  it("do not change how a built-in tool that needs approval is treated", async () => {
    const perms = await fresh();
    perms.initPermissions({ confirm: vi.fn() });
    perms.addBeforeHook(() => ({ confirm: true, reason: "it is a dangerous command" }));
    perms.setUnattended(true);
    const out = await perms.executeToolWithPermissions("run_command", { command: "rm -rf ./tmp" });
    expect(out.denied).toBe(true);
  });

  // The test above is refused by its hook whatever getPermission() answers, so
  // it stayed green when the `server &&` condition was removed and EVERY tool
  // that asks became "allow" in a headless run. This one has no hook: the only
  // thing between the tool and its execution is that it is not an MCP tool.
  it("leave a tool that is not an MCP tool, and asks by default, refused", async () => {
    const perms = await fresh();
    perms.initPermissions({ confirm: vi.fn() });
    const notMcp = "some_plugin_tool";
    perms.setUnattended(false);
    expect(perms.getPermission(notMcp), "precondition: this tool asks by default").toBe("confirm");
    perms.setUnattended(true);
    expect(perms.getPermission(notMcp)).toBe("confirm");
    const out = await perms.executeToolWithPermissions(notMcp, {});
    expect(out.denied).toBe(true);
    expect(mockExecuteTool).not.toHaveBeenCalled();
  });

  // Every test above runs on a mocked config with no headlessMcp at all, so
  // none of them reads the default. The real one is checked here.
  it("is the default of the real config, and FLINT_HEADLESS_MCP=ask turns it off", async () => {
    const saved = process.env.FLINT_HEADLESS_MCP;
    try {
      delete process.env.FLINT_HEADLESS_MCP;
      vi.resetModules();
      expect((await vi.importActual("../../../src/config.js")).config.headlessMcp).toBe("allow");
      process.env.FLINT_HEADLESS_MCP = "ask";
      vi.resetModules();
      expect((await vi.importActual("../../../src/config.js")).config.headlessMcp).toBe("ask");
    } finally {
      if (saved === undefined) delete process.env.FLINT_HEADLESS_MCP; else process.env.FLINT_HEADLESS_MCP = saved;
      vi.resetModules();
    }
  });
});
