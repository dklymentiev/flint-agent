// A model sometimes calls a tool by a name Flint does not have. The usual case
// is an MCP tool called by the server's own name: the server's instructions say
// `inbox_reply`, Flint registered it as `mcp_messaging_inbox_reply`. Such a name
// used to fall through to the default permission "confirm", so the operator was
// asked about a tool that does not exist, and a headless run ended the turn with
// "needs the operator's approval" instead of telling the model the name is wrong.
//
// Runs against the real registry: the question is what a name refers to, and a
// mocked registry would only answer what the test told it to.
import { describe, it, expect, vi, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "unknown-tool-"));
const sessionsDir = path.join(tmpBase, "sessions");

vi.mock("../../../src/config.js", async (importOriginal) => {
  const real = await importOriginal();
  return { config: { ...real.config, projectRoot: tmpBase, sessionsDir } };
});

afterAll(() => {
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

const ran = [];

function mcpTool(server, tool) {
  const name = `mcp_${server}_${tool}`;
  return { def: { type: "function", function: { name, description: "", parameters: { type: "object", properties: {} } } }, name };
}

// Registers MCP tools the way the MCP client does: the definition and handler
// in the registry, and which server each came from.
async function fresh(tools) {
  vi.resetModules();
  ran.length = 0;
  try { fs.unlinkSync(path.join(tmpBase, ".permissions.json")); } catch {}
  const registry = await import("../../../src/tools/registry.js");
  const servers = await import("../../../src/tools/mcp-tool-servers.js");
  const perms = await import("../../../src/tools/permissions.js");
  const defs = [];
  const handlers = {};
  for (const [server, tool] of tools) {
    const t = mcpTool(server, tool);
    defs.push(t.def);
    handlers[t.name] = async () => { ran.push(t.name); return `ok:${t.name}`; };
    servers.noteMcpTool(t.name, server);
  }
  registry.registerMcpTools(defs, handlers, []);
  return perms;
}

describe("a tool name Flint does not have", () => {
  for (const unattended of [false, true]) {
    const mode = unattended ? "headless" : "with an operator";

    it(`is answered to the model, not asked about (${mode})`, async () => {
      const perms = await fresh([["messaging", "inbox_list"]]);
      const confirm = vi.fn(async () => "yes");
      perms.initPermissions({ confirm });
      perms.setUnattended(unattended);
      const out = await perms.executeToolWithPermissions("no_such_tool", {});
      expect(confirm).not.toHaveBeenCalled();
      expect(out.denied).toBeFalsy();
      expect(String(out.result)).toContain('unknown tool "no_such_tool"');
      expect(ran).toEqual([]);
    });

    it(`runs the MCP tool when it is the server's own name for exactly one tool (${mode})`, async () => {
      const perms = await fresh([["messaging", "inbox_reply"], ["messaging", "inbox_list"]]);
      const confirm = vi.fn(async () => "yes");
      perms.initPermissions({ confirm });
      perms.setUnattended(unattended);
      const out = await perms.executeToolWithPermissions("inbox_reply", {});
      expect(out.denied).toBeFalsy();
      expect(out.name).toBe("mcp_messaging_inbox_reply");
      expect(ran).toEqual(["mcp_messaging_inbox_reply"]);
    });
  }

  it("runs nothing when two servers have a tool of that name, and names both", async () => {
    const perms = await fresh([["messaging", "inbox_reply"], ["mail", "inbox_reply"]]);
    const confirm = vi.fn(async () => "yes");
    perms.initPermissions({ confirm });
    perms.setUnattended(false);
    const out = await perms.executeToolWithPermissions("inbox_reply", {});
    expect(confirm).not.toHaveBeenCalled();
    expect(ran).toEqual([]);
    expect(String(out.result)).toContain("mcp_messaging_inbox_reply");
    expect(String(out.result)).toContain("mcp_mail_inbox_reply");
  });

  it("keeps a rule set on the full name: a denied tool stays denied under its short name", async () => {
    const perms = await fresh([["messaging", "inbox_reply"]]);
    perms.initPermissions({ confirm: vi.fn(async () => "yes") });
    perms.setPermission("mcp_messaging_inbox_reply", "deny");
    const out = await perms.executeToolWithPermissions("inbox_reply", {});
    expect(out.denied).toBe(true);
    expect(ran).toEqual([]);
  });

  // Server "a" with tool "b_reply" and server "a_b" with tool "reply" are both
  // mcp_a_b_reply, so a name is matched through the server the tool came from,
  // never by cutting the string: "reply" belongs to server a_b only.
  it("matches the server's own name exactly, not any name that ends the same way", async () => {
    const perms = await fresh([["messaging", "send_reply"]]);
    perms.initPermissions({ confirm: vi.fn(async () => "yes") });
    perms.setUnattended(true);
    const out = await perms.executeToolWithPermissions("reply", {});
    expect(ran).toEqual([]);
    expect(String(out.result)).toContain('unknown tool "reply"');
  });
});
