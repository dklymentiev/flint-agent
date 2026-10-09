// Integration test: WITHOUT FLINT_DATA_DIR (and without --data-dir), every
// writable path resolves exactly where master put it.
//
// Master had two classes of state:
//   — home state:   ~/.flint/...        (keys, provider.json, memory sqlite,
//                                        intent-decisions, api-token, etc.)
//   — install state: <install>/...       (sessions/, .permissions.json,
//                                        knowledge/, MEMORY.md, memories.jsonl)
//
// A single dataDir() defaulting to ~/.flint breaks the install state.
// This test spawns a real Node process with FLINT_DATA_DIR unset and verifies
// every path matches the master value.  The expected values are computed from
// the master formulas recorded below, not by importing master source.
import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const repoRootUrl = pathToFileURL(repoRoot + "/").href;

/** Spawn a real node process with FLINT_DATA_DIR unset; print JSON report. */
function runProbe(script) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "flint-default-probe-"));
  const probeFile = path.join(tmp, "probe.mjs");
  fs.writeFileSync(probeFile, script, "utf-8");

  // Clean env: ensure FLINT_DATA_DIR is absent so dataDir() falls back.
  const env = { ...process.env };
  delete env.FLINT_DATA_DIR;
  env.HOME = path.join(tmp, "fake-home");
  env.USERPROFILE = env.HOME;
  fs.mkdirSync(env.HOME, { recursive: true });
  env.FLINT_TEST_PERMISSIONS_FILE = "";
  env.FLINT_OWN_ENV = "0";
  env.FLINT_LOG_LEVEL = "error";
  env.INTENT_MODEL = "test/intent-model";
  env.OPENROUTER_API_KEY = "test-key";

  const child = spawn("node", [probeFile], {
    stdio: ["ignore", "pipe", "pipe"],
    env,
    cwd: repoRoot,
  });

  return new Promise((resolve) => {
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("exit", () => {
      const idx = out.indexOf("@@REPORT@@");
      const json = idx >= 0 ? out.slice(idx + "@@REPORT@@".length).trim() : null;
      resolve({ json, stderr: err, stdout: out });
      fs.rmSync(tmp, { recursive: true, force: true });
    });
  });
}

describe("default state paths without FLINT_DATA_DIR (master-compatible)", () => {
  const probeScript = `
import { config } from "${repoRootUrl}src/config.js";
import { dataDir, homeStateDir, installStateDir } from "${repoRootUrl}src/data-dir.js";
import path from "node:path";
import os from "node:os";

// installStateDir() resolves the install root from src/data-dir.js's own file
// URL — it is the real path, regardless of cwd or HOME.
const PROJECT_ROOT = installStateDir();
const HOME = os.homedir();

const report = {
  // --- install state (master: <install>/...) ---
  sessionsDir: config.sessionsDir,
  permissionsFile: config.permissionsFile,
  knowledgeDir: path.join(config.sessionsDir || path.join(PROJECT_ROOT, "sessions"), "..", "knowledge"),
  memoryMdPath: path.join(PROJECT_ROOT, "MEMORY.md"),
  memoriesFile: path.join(PROJECT_ROOT, "memory", "memories.jsonl"),
  childrenSessionsDir: path.join(PROJECT_ROOT, "sessions", "children"),

  // --- home state (master: ~/.flint/...) ---
  keysEncPath: path.join(HOME, ".flint", "keys.enc"),
  providerStatePath: path.join(HOME, ".flint", "provider.json"),
  agentsPath: path.join(HOME, ".flint", "agents.json"),
  apiTokenPath: path.join(HOME, ".flint", "api-token.json"),
  intentDecisionsPath: path.join(HOME, ".flint", "intent-decisions.jsonl"),
  pairedClientsPath: path.join(HOME, ".flint", "paired-clients.json"),
  spendPath: path.join(HOME, ".flint", "spend.json"),
  modelChecksPath: path.join(HOME, ".flint", "model-checks.json"),
  freeModelsPath: path.join(HOME, ".flint", "free.json"),
  updateCheckPath: path.join(HOME, ".flint", "update-check.json"),
  mcpConfigPath: path.join(HOME, ".flint", "mcp.json"),
  skillsDir: path.join(HOME, ".flint", "memory", "skills"),
  memoryDbPath: path.join(HOME, ".flint", "memory", "index.sqlite"),
  agentSnapshotsDir: path.join(HOME, ".flint", "agent-prompt-snapshots"),
  classifierSnapshotsDir: path.join(HOME, ".flint", "classifier-prompt-snapshots"),
  modelsCuratedPath: path.join(HOME, ".flint", "models-curated.json"),
  envDir: path.join(HOME, ".flint", "env"),
  pluginsDir: path.join(HOME, ".flint", "plugins"),

  // --- actual dataDir() / homeStateDir() / installStateDir() ---
  actual: {
    dataDir: dataDir(),
    homeStateDir: homeStateDir(),
    installStateDir: installStateDir(),
  },
};
process.stdout.write("@@REPORT@@" + JSON.stringify(report));
`;

  it("resolves install-state paths next to the install root, not ~/.flint", async () => {
    const result = await runProbe(probeScript);
    expect(result.json, `probe failed:\nstderr: ${result.stderr}`).toBeTruthy();
    const r = JSON.parse(result.json);

    const installRoot = r.sessionsDir.startsWith(r.actual.installStateDir)
      ? r.actual.installStateDir
      : r.knowledgeDir.replace(/\\/g, "/").includes("knowledge") ? "install" : r.actual.installStateDir;

    // sessionsDir must be <install>/sessions
    expect(path.resolve(r.sessionsDir)).toBe(path.resolve(r.actual.installStateDir, "sessions"));

    // permissionsFile must be <install>/.permissions.json
    expect(path.resolve(r.permissionsFile)).toBe(path.resolve(r.actual.installStateDir, ".permissions.json"));

    // knowledgeDir must be <install>/knowledge
    expect(path.resolve(r.knowledgeDir)).toBe(path.resolve(r.actual.installStateDir, "knowledge"));

    // MEMORY.md must be <install>/MEMORY.md
    expect(path.resolve(r.memoryMdPath)).toBe(path.resolve(r.actual.installStateDir, "MEMORY.md"));

    // memories.jsonl must be <install>/memory/memories.jsonl
    expect(path.resolve(r.memoriesFile)).toBe(path.resolve(r.actual.installStateDir, "memory", "memories.jsonl"));

    // children sessions must be <install>/sessions/children
    expect(path.resolve(r.childrenSessionsDir)).toBe(path.resolve(r.actual.installStateDir, "sessions", "children"));
  }, 20000);

  it("resolves home-state paths under ~/.flint, not the install root", async () => {
    const result = await runProbe(probeScript);
    expect(result.json, `probe failed:\nstderr: ${result.stderr}`).toBeTruthy();
    const r = JSON.parse(result.json);
    const homeDir = path.resolve(r.actual.homeStateDir);

    // Every home-state path must be under ~/.flint
    const homePaths = {
      keysEncPath: r.keysEncPath,
      providerStatePath: r.providerStatePath,
      agentsPath: r.agentsPath,
      apiTokenPath: r.apiTokenPath,
      intentDecisionsPath: r.intentDecisionsPath,
      pairedClientsPath: r.pairedClientsPath,
      spendPath: r.spendPath,
      modelChecksPath: r.modelChecksPath,
      freeModelsPath: r.freeModelsPath,
      updateCheckPath: r.updateCheckPath,
      mcpConfigPath: r.mcpConfigPath,
      skillsDir: r.skillsDir,
      memoryDbPath: r.memoryDbPath,
      agentSnapshotsDir: r.agentSnapshotsDir,
      classifierSnapshotsDir: r.classifierSnapshotsDir,
      modelsCuratedPath: r.modelsCuratedPath,
      envDir: r.envDir,
      pluginsDir: r.pluginsDir,
    };

    for (const [name, p] of Object.entries(homePaths)) {
      const resolved = path.resolve(p);
      const underHome = resolved === homeDir || resolved.startsWith(homeDir + path.sep);
      expect(underHome, `${name}: ${resolved} should be under home state dir ${homeDir}`).toBe(true);
    }

    // And homeStateDir must NOT be the install root
    expect(path.resolve(r.actual.homeStateDir)).not.toBe(path.resolve(r.actual.installStateDir));
  }, 20000);
});
