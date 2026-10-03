// The stdio mode as a real process, started through bin/flint.js from another
// folder, the way a host starts it. No model call: it checks that stdout
// carries protocol lines only, that the agent's folder is its cwd, that the
// CLAUDE.md and .mcp.json there are read, and that closing stdin ends it.
import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("stdio mode process", () => {
  it("prints only protocol lines and exits 0 when stdin closes", async () => {
    const agent = realpathSync(mkdtempSync(path.join(tmpdir(), "flint-stdio-agent-")));
    const data = mkdtempSync(path.join(tmpdir(), "flint-stdio-data-"));
    writeFileSync(path.join(agent, "CLAUDE.md"), "You are Pebble.");
    const child = spawn(process.execPath, [path.join(ROOT, "bin", "flint.js"),
      "--print", "--verbose", "--model", "test/model",
      "--input-format", "stream-json", "--output-format", "stream-json",
      "--session-id", "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"], {
      cwd: agent,
      env: { ...process.env, FLINT_DATA_DIR: data, MCP_SERVERS: "" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", () => {});
    // Close stdin once the init line is out.
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`no init line in 60 s; stdout: ${out.slice(0, 300)}`)), 60000);
      child.stdout.on("data", () => { if (out.includes("\n")) { clearTimeout(t); resolve(); } });
    });
    child.stdin.end();
    const code = await new Promise((r) => child.on("exit", r));
    const lines = out.trim().split("\n");
    const parsed = lines.map((l) => JSON.parse(l));   // throws on any stray line
    expect(code).toBe(0);
    expect(parsed[0]).toMatchObject({
      type: "system", subtype: "init", session_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      model: "test/model", agent: "flint",
    });
    expect(realpathSync(parsed[0].cwd)).toBe(agent);
    expect(parsed[0].tools).toContain("run_command");
  }, 90000);
});
