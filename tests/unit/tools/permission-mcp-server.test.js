// One answer for a whole MCP server (owner, 2026-10-03). "[a] always" is
// remembered under one tool's name, so mcp_analytics_list_sites and
// mcp_analytics_get_stats each asked, and so did the other fifty tools of five
// servers. An operator who has to say yes fifty times stops reading the
// question.
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "perm-mcp-server-"));
const sessionsDir = path.join(tmpBase, "sessions");
const permFile = path.join(tmpBase, ".permissions.json");

const mockExecuteTool = vi.fn(async (name) => `result:${name}`);

vi.mock("../../../src/config.js", () => ({
  config: { projectRoot: tmpBase, sessionsDir },
}));

vi.mock("../../../src/tools/registry.js", () => ({
  executeTool: (...args) => mockExecuteTool(...args),
  getDefinitions: () => [],
}));

afterAll(() => {
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

// A start of Flint: module state gone, the permissions file kept unless asked.
async function start({ wipe = false } = {}) {
  vi.resetModules();
  mockExecuteTool.mockClear();
  if (wipe) { try { fs.unlinkSync(permFile); } catch {} }
  const mod = await import("../../../src/tools/permissions.js");
  const servers = await import("../../../src/tools/mcp-tool-servers.js");
  // What the MCP client does when a server connects.
  servers.noteMcpTool("mcp_analytics_list_sites", "analytics");
  servers.noteMcpTool("mcp_analytics_get_stats", "analytics");
  servers.noteMcpTool("mcp_notes_search", "notes");
  // Two servers whose names share a prefix: "a" has a tool "b_y", "a_b" has "x".
  servers.noteMcpTool("mcp_a_b_y", "a");
  servers.noteMcpTool("mcp_a_b_x", "a_b");
  return mod;
}

function withConfirm(mod, answers) {
  const confirm = vi.fn(async () => answers.shift() ?? "no");
  mod.initPermissions({ confirm, timeout: 2000 });
  return confirm;
}

describe("one approval for a whole MCP server", () => {
  let mod;
  beforeEach(async () => { mod = await start({ wipe: true }); });

  it("offers the server choice on an MCP tool and stops asking for that server", async () => {
    const confirm = withConfirm(mod, ["server", "yes"]);

    const first = await mod.executeToolWithPermissions("mcp_analytics_list_sites", {});
    expect(first.denied).toBe(false);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0][2].server).toBe("analytics");

    const second = await mod.executeToolWithPermissions("mcp_analytics_get_stats", { site_id: "x" });
    expect(second.denied).toBe(false);
    expect(confirm).toHaveBeenCalledTimes(1); // not asked again

    await mod.executeToolWithPermissions("mcp_notes_search", { query: "q" });
    expect(confirm).toHaveBeenCalledTimes(2); // another server still asks
  });

  it("keeps the server approval across a restart", async () => {
    withConfirm(mod, ["server"]);
    await mod.executeToolWithPermissions("mcp_analytics_list_sites", {});

    mod = await start(); // same file, new process
    const confirm = withConfirm(mod, []);
    const r = await mod.executeToolWithPermissions("mcp_analytics_get_stats", {});
    expect(r.denied).toBe(false);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("lets a rule for one tool beat the server approval", async () => {
    withConfirm(mod, ["server"]);
    await mod.executeToolWithPermissions("mcp_analytics_list_sites", {});

    mod.setPermission("mcp_analytics_get_stats", "deny");
    const denied = await mod.executeToolWithPermissions("mcp_analytics_get_stats", {});
    expect(denied.denied).toBe(true);

    mod.setPermission("mcp_analytics_get_stats", "confirm");
    const confirm = withConfirm(mod, ["yes"]);
    await mod.executeToolWithPermissions("mcp_analytics_get_stats", {});
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it("tells servers apart by registration, not by splitting the tool name", async () => {
    const confirm = withConfirm(mod, ["server", "yes"]);
    await mod.executeToolWithPermissions("mcp_a_b_y", {}); // server "a"
    expect(confirm.mock.calls[0][2].server).toBe("a");

    await mod.executeToolWithPermissions("mcp_a_b_x", {}); // server "a_b", same prefix
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(confirm.mock.calls[1][2].server).toBe("a_b");
  });

  it("does not offer the server choice for a built-in tool, and does not take it as a yes", async () => {
    mod.saveOnboardingAnswer("safe"); // write_file asks at this level
    const confirm = withConfirm(mod, ["server"]);
    const r = await mod.executeToolWithPermissions("write_file", { path: path.join(tmpBase, "x.txt"), content: "x" });
    expect(confirm.mock.calls[0][2].server).toBeFalsy();
    expect(r.denied).toBe(true);
    expect(mockExecuteTool).not.toHaveBeenCalled();
  });

  it("does not offer it when a hook forced the question for its own reason", async () => {
    mod.addBeforeHook(async (name) =>
      name === "mcp_analytics_get_stats" ? { confirm: true, reason: "a hook's own reason", key: "hook:key" } : null);
    const confirm = withConfirm(mod, ["yes"]);
    await mod.executeToolWithPermissions("mcp_analytics_get_stats", {});
    expect(confirm.mock.calls[0][2].server).toBeFalsy();
    expect(confirm.mock.calls[0][2].key).toBe("hook:key");
  });

  it("shows the server rule in the permission map and drops it on reset", async () => {
    withConfirm(mod, ["server"]);
    await mod.executeToolWithPermissions("mcp_analytics_list_sites", {});
    expect(mod.getPermissionMap()[mod.mcpServerKey("analytics")]).toBe("allow");

    mod.resetSessionOverrides();
    const confirm = withConfirm(mod, ["yes"]);
    await mod.executeToolWithPermissions("mcp_analytics_get_stats", {});
    expect(confirm).toHaveBeenCalledTimes(1);
  });
});

// /allow-all is never written to disk, so every restart used to drop it while
// keeping the session. The level now rides along with the restart itself.
describe("the blanket level across a restart of the same session", () => {
  let mod;
  beforeEach(async () => { mod = await start({ wipe: true }); });

  const fakeProc = () => {
    const proc = { connected: true, sent: [], exited: null };
    proc.send = (msg, cb) => { proc.sent.push(msg); cb?.(); };
    proc.exit = (code) => { proc.exited = code; };
    return proc;
  };

  it("tells the launcher the level when /allow-all is on", async () => {
    vi.useFakeTimers();
    try {
      mod.bulkSetPermission("allow");
      const { restartKeepingSession } = await import("../../../src/restart.js");
      const proc = fakeProc();
      restartKeepingSession("session-1", 10, proc);
      vi.advanceTimersByTime(20);
      expect(proc.sent[0]).toMatchObject({ type: "flint:restart", sessionId: "session-1", bulkPermission: "allow" });
      expect(proc.exited).toBe(42);
    } finally {
      vi.useRealTimers();
    }
  });

  it("carries /deny-all the same way and nothing when neither is on", async () => {
    vi.useFakeTimers();
    try {
      const { restartKeepingSession } = await import("../../../src/restart.js");
      const quiet = fakeProc();
      restartKeepingSession("session-1", 10, quiet);
      vi.advanceTimersByTime(20);
      expect(quiet.sent[0].bulkPermission ?? null).toBe(null);

      mod.bulkSetPermission("deny");
      const proc = fakeProc();
      restartKeepingSession("session-1", 10, proc);
      vi.advanceTimersByTime(20);
      expect(proc.sent[0].bulkPermission).toBe("deny");
    } finally {
      vi.useRealTimers();
    }
  });

  it("takes the level back only from a well-formed launcher message", async () => {
    const { carriedBulkPermission } = await import("../../../src/restart.js");
    expect(carriedBulkPermission({ type: "flint:released", bulkPermission: "allow" })).toBe("allow");
    expect(carriedBulkPermission({ type: "flint:released", bulkPermission: "deny" })).toBe("deny");
    expect(carriedBulkPermission({ type: "flint:released" })).toBe(null);
    expect(carriedBulkPermission({ type: "flint:released", bulkPermission: "confirm" })).toBe(null);
    expect(carriedBulkPermission({ type: "flint:released", bulkPermission: true })).toBe(null);
    expect(carriedBulkPermission(null)).toBe(null);
  });

  // A level that now outlives a restart needs a way out that is not a restart.
  it("is turned off by /reset-permissions", async () => {
    mod.saveOnboardingAnswer("safe");
    mod.bulkSetPermission("allow");
    expect(mod.getPermission("write_file")).toBe("allow");
    mod.resetSessionOverrides();
    expect(mod.getBulkPermission()).toBe(null);
    expect(mod.getPermission("write_file")).toBe("confirm");
  });

  it("starts without it whatever the environment or the permissions file says", async () => {
    process.env.FLINT_ALLOW_ALL = "1";
    process.env.FLINT_BULK_PERMISSION = "allow";
    fs.writeFileSync(permFile, JSON.stringify({ bulkPermission: "allow", _globalPermission: "allow" }));
    try {
      mod = await start();
      expect(mod.getBulkPermission()).toBe(null);
      mod.saveOnboardingAnswer("safe");
      expect(mod.getPermission("write_file")).toBe("confirm");
    } finally {
      delete process.env.FLINT_ALLOW_ALL;
      delete process.env.FLINT_BULK_PERMISSION;
    }
  });
});

// What the operator sees: the third choice has to be on the screen, or it does
// not exist for them.
describe("the approval prompt", () => {
  it("offers [s] with the server's name for an MCP tool and not otherwise", async () => {
    const { confirmRows } = await import("../../../src/components/LiveZone.js");
    const mcp = confirmRows({ pendingConfirmation: "mcp_analytics_get_stats", pendingConfirmationArgs: "", pendingConfirmationServer: "analytics" }, Date.now(), 120);
    expect(mcp[0]).toContain("[s]");
    expect(mcp[0]).toContain("analytics");

    const builtin = confirmRows({ pendingConfirmation: "write_file", pendingConfirmationArgs: "", pendingConfirmationServer: null }, Date.now(), 120);
    expect(builtin[0]).not.toContain("[s]");
    expect(builtin[0]).toContain("[a] always");
  });
});

// The real launcher with a stand-in child, over real IPC: the unit tests above
// cover the two ends, this covers the process in the middle that has to hold
// the level while one child exits and the next one starts.
describe("the launcher hands the level to the restarted process", () => {
  const { spawnSync } = require("node:child_process");

  function runLauncher(level) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "flint-launcher-"));
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module", version: "0.0.0" }));
    fs.copyFileSync(path.resolve("src/launcher.js"), path.join(root, "src", "launcher.js"));
    // Run 1 (no --session): asks for a restart, with the level.
    // Run 2 (--session s1): records what the launcher answered, restarts again with no level.
    // Run 3 (--session s2): records again and ends.
    fs.writeFileSync(path.join(root, "src", "index.js"), `
      import fs from "node:fs";
      import path from "node:path";
      const args = process.argv.slice(2);
      const at = args.indexOf("--session");
      const session = at === -1 ? null : args[at + 1];
      process.on("message", (msg) => {
        if (!msg || msg.type !== "flint:released") return;
        if (!session) {
          process.send({ type: "flint:restart", sessionId: "s1", bulkPermission: ${JSON.stringify(level)} }, () => process.exit(42));
          return;
        }
        fs.writeFileSync(path.join(${JSON.stringify(root)}, session + ".json"), JSON.stringify(msg));
        if (session === "s1") process.send({ type: "flint:restart", sessionId: "s2" }, () => process.exit(42));
        else process.exit(0);
      });
      process.send({ type: "flint:ready" });
    `);
    const run = spawnSync(process.execPath, [path.join(root, "src", "launcher.js")], { encoding: "utf8", timeout: 20000 });
    const read = (name) => JSON.parse(fs.readFileSync(path.join(root, name + ".json"), "utf8"));
    const out = { status: run.status, first: read("s1"), second: read("s2") };
    fs.rmSync(root, { recursive: true, force: true });
    return out;
  }

  it("gives /allow-all to the next process once, and not to the one after", () => {
    const r = runLauncher("allow");
    expect(r.status).toBe(0);
    expect(r.first).toEqual({ type: "flint:released", bulkPermission: "allow" });
    expect(r.second).toEqual({ type: "flint:released" });
  });

  it("does not pass on a level it does not know", () => {
    const r = runLauncher("confirm");
    expect(r.first).toEqual({ type: "flint:released" });
  });
});
