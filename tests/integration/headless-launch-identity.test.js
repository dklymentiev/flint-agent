// Integration test: headless mode should support launch identity settings
// (instructions via --system-prompt / --system-prompt-file / CLAUDE.md,
// and MCP servers via .mcp.json or MCP_SERVERS env).
//
// This test calls bootstrap() directly with a headless cli object, like
// tests/integration/headless-cwd-real.test.js does, and checks the resulting
// app state.

import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "flint-hd-id-"));
const origCwd = process.cwd();
const origEnv = { ...process.env };

const dirA = repoRoot;

afterAll(() => {
  try { process.chdir(origCwd); } catch {}
  for (const k of Object.keys(process.env)) {
    if (!(k in origEnv)) delete process.env[k];
  }
  for (const [k, v] of Object.entries(origEnv)) {
    process.env[k] = v;
  }
  // Cleanup may fail on Windows with EBUSY if SQLite connections are still
  // being closed; that is not a test failure.
  try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch {}
});

function norm(p) {
  return String(p).replace(/\\/g, "/").toLowerCase();
}

/** Set isolated env for headless runs */
function isolatedEnv(dataDir, homeDir) {
  process.env.FLINT_DATA_DIR = dataDir;
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;
  process.env.INTENT_MODEL = "test/intent-model";
  process.env.FLINT_OWN_ENV = "0";
  process.env.OPENROUTER_API_KEY = "sk-fake";
}

/** Run real headless startup in repo root, with --cwd at target. */
async function startHeadlessRun(cwd, cliExtras = {}) {
  process.chdir(dirA);
  const { app } = await import("../../src/app-state.js");
  const { bootstrap } = await import("../../src/bootstrap.js");
  const cli = { action: "headless", cwd, task: "say hi", ...cliExtras };
  await bootstrap(cli, { name: "flint", version: "test" });
  return { app, cli };
}

describe("headless launch identity", () => {
  it("parses --system-prompt flag in headless mode", async () => {
    const workDir = path.join(tmpBase, "work1");
    const dataDir = path.join(tmpBase, "data1");
    const homeDir = path.join(tmpBase, "home1");
    fs.mkdirSync(workDir, { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(path.join(homeDir, ".flint"), { recursive: true });
    isolatedEnv(dataDir, homeDir);

    const { app } = await startHeadlessRun(workDir, {
      systemPrompt: "You are Pebble, a friendly robot.",
    });

    expect(app.hostPrompt).toBeTruthy();
    expect(app.hostPrompt).toContain("Pebble");
    try { process.chdir(origCwd); } catch {}
  }, 60000);

  it("reads CLAUDE.md from --cwd in headless mode", async () => {
    const workDir = path.join(tmpBase, "work2");
    const dataDir = path.join(tmpBase, "data2");
    const homeDir = path.join(tmpBase, "home2");
    fs.mkdirSync(workDir, { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(path.join(homeDir, ".flint"), { recursive: true });
    fs.writeFileSync(path.join(workDir, "CLAUDE.md"), "IDENTITY_FROM_CLAUDE_MD");
    isolatedEnv(dataDir, homeDir);

    const { app } = await startHeadlessRun(workDir);

    expect(app.hostPrompt).toBeTruthy();
    expect(app.hostPrompt).toContain("IDENTITY_FROM_CLAUDE_MD");
    try { process.chdir(origCwd); } catch {}
  }, 60000);

  it("reads --system-prompt-file in headless mode", async () => {
    const workDir = path.join(tmpBase, "work3");
    const dataDir = path.join(tmpBase, "data3");
    const homeDir = path.join(tmpBase, "home3");
    fs.mkdirSync(workDir, { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(path.join(homeDir, ".flint"), { recursive: true });
    const instrFile = path.join(tmpBase, "instructions.txt");
    fs.writeFileSync(instrFile, "FILE_INSTRUCTIONS_999");
    isolatedEnv(dataDir, homeDir);

    const { app } = await startHeadlessRun(workDir, {
      systemPromptFile: instrFile,
    });

    expect(app.hostPrompt).toBeTruthy();
    expect(app.hostPrompt).toContain("FILE_INSTRUCTIONS_999");
    try { process.chdir(origCwd); } catch {}
  }, 60000);

  it("parses --system-prompt and --system-prompt-file from argv", async () => {
    const { parseCLI } = await import("../../src/cli.js");
    const origArgv = process.argv;
    process.argv = [
      "node", "flint", "--headless",
      "--task", "test",
      "--cwd", "/some/dir",
      "--system-prompt", "Hello from flag",
      "--system-prompt-file", "/some/file.txt",
    ];
    const cli = parseCLI();
    process.argv = origArgv;

    expect(cli.systemPrompt).toBe("Hello from flag");
    expect(cli.systemPromptFile).toBe("/some/file.txt");
  });

  it("parses --append-system-prompt and --append-system-prompt-file from argv", async () => {
    const { parseCLI } = await import("../../src/cli.js");
    const origArgv = process.argv;
    process.argv = [
      "node", "flint", "--headless",
      "--task", "test",
      "--cwd", "/some/dir",
      "--append-system-prompt", "Extra rules",
      "--append-system-prompt-file", "/some/extra.txt",
    ];
    const cli = parseCLI();
    process.argv = origArgv;

    expect(cli.appendSystemPrompt).toBe("Extra rules");
    expect(cli.appendSystemPromptFile).toBe("/some/extra.txt");
  });

  it("reads .mcp.json from --cwd in headless mode", async () => {
    const workDir = path.join(tmpBase, "work4");
    const dataDir = path.join(tmpBase, "data4");
    const homeDir = path.join(tmpBase, "home4");
    fs.mkdirSync(workDir, { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(path.join(homeDir, ".flint"), { recursive: true });
    const mcpConfig = {
      mcpServers: {
        local_echo: {
          type: "stdio",
          command: "python3",
          args: ["/nonexistent"]
        }
      }
    };
    fs.writeFileSync(
      path.join(workDir, ".mcp.json"),
      JSON.stringify(mcpConfig, null, 2)
    );
    isolatedEnv(dataDir, homeDir);

    const { bootstrap } = await import("../../src/bootstrap.js");
    const { config } = await import("../../src/config.js");
    process.chdir(dirA);
    const cli = { action: "headless", cwd: workDir, task: "say hi" };
    await bootstrap(cli, { name: "flint", version: "test" });

    expect(config.mcpServers).toBeTruthy();
    // The local_echo server from .mcp.json should be in the config
    const serverList = Array.isArray(config.mcpServers) ? config.mcpServers : [config.mcpServers];
    const names = serverList.filter(Boolean).map(s => typeof s === "string" ? s : s.name);
    expect(names).toContain("local_echo");
    try { process.chdir(origCwd); } catch {}
  }, 60000);

  it("isolated: two headless runs with different --cwd and instructions do not see each other", async () => {
    const workDir1 = path.join(tmpBase, "iso1");
    const workDir2 = path.join(tmpBase, "iso2");
    const dataDir = path.join(tmpBase, "dataiso");
    const homeDir = path.join(tmpBase, "homeiso");
    fs.mkdirSync(workDir1, { recursive: true });
    fs.mkdirSync(workDir2, { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(path.join(homeDir, ".flint"), { recursive: true });
    fs.writeFileSync(path.join(workDir1, "CLAUDE.md"), "INSTRUCTIONS_FOR_AGENT_1");
    fs.writeFileSync(path.join(workDir2, "CLAUDE.md"), "INSTRUCTIONS_FOR_AGENT_2");
    isolatedEnv(dataDir, homeDir);

    const { app } = await import("../../src/app-state.js");

    // Run 1
    process.chdir(dirA);
    const { bootstrap } = await import("../../src/bootstrap.js");
    const cli1 = { action: "headless", cwd: workDir1, task: "say hi" };
    await bootstrap(cli1, { name: "flint", version: "test" });
    const prompt1 = app.hostPrompt || "";

    // Run 2 — must NOT contain run 1's instructions
    const cli2 = { action: "headless", cwd: workDir2, task: "say hi" };
    await bootstrap(cli2, { name: "flint", version: "test" });
    const prompt2 = app.hostPrompt || "";

    expect(prompt2).toContain("INSTRUCTIONS_FOR_AGENT_2");
    expect(prompt2).not.toContain("INSTRUCTIONS_FOR_AGENT_1");
    try { process.chdir(origCwd); } catch {}
  }, 60000);
});
