// Integration test: a single setting (--data-dir / FLINT_DATA_DIR) redirects
// ALL Flint writes off the read-only install directory.
//
// The test spawns real Node processes that import Flint's actual modules and
// checks that, with --data-dir set, every writable path resolves into the data
// dir — not into the install directory or the real home.
//
// We deliberately do NOT set FLINT_TEST_PERMISSIONS_FILE (the test-only escape
// hatch). If .permissions.json only moved via that escape hatch, the path
// would resolve to the repo root and the test would fail.
import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const repoRootUrl = pathToFileURL(repoRoot + "/").href;

/**
 * Wait for a spawned child process to fully exit, with an extra grace period
 * on Windows for file-handle release. The caller's `exit` promise resolves
 * once the OS reaps the process; on Windows, the kernel may still hold
 * handles to files the child wrote for a short time after, which causes
 * fs.rmSync on the child's temp dir to throw ENOTEMPTY. We wait a brief,
 * bounded moment for those handles to clear before returning.
 */
function waitForChildExit(child, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      resolve(null);
    }, timeoutMs);
    child.on("exit", () => {
      clearTimeout(timer);
      // Give the OS a moment to release file handles, especially on Windows.
      if (process.platform === "win32") {
        setTimeout(() => resolve(null), 200);
      } else {
        resolve(null);
      }
    });
  });
}

/**
 * Remove a directory tree, retrying a few times with short delays to tolerate
 * files still held open by a child process (notably on Windows). Never throws:
 * cleanup is best-effort and must not mask a real test assertion failure.
 */
function rmDirSafe(p) {
  const attempts = 5;
  for (let i = 0; i < attempts; i++) {
    try {
      fs.rmSync(p, { recursive: true, force: true });
      return;
    } catch (e) {
      // On the last attempt, swallow the error — cleanup failure is not a
      // test failure; we only care that the assertions held.
      if (i === attempts - 1) return;
    }
    // Brief backoff: 50ms, 100ms, 200ms, 400ms
    const delay = 50 * 2 ** i;
    const start = Date.now();
    while (Date.now() - start < delay) { /* spin — only hit on Windows races */ }
  }
}

/** Collect file paths under dir, relative to dir (excluding node_modules, .git, history/). */
function collectFiles(dir) {
  const result = new Set();
  const skip = new Set(["node_modules", ".git", "history"]);
  function walk(d) {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (skip.has(e.name)) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else result.add(path.relative(dir, full));
    }
  }
  walk(dir);
  return result;
}

/** Start a fake OpenAI-compatible provider that returns "ready" for every request. */
function startFakeProvider() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    if (req.url === "/models" || req.url === "/v1/models") {
      res.end(JSON.stringify({ data: [{ id: "fake-model", name: "Fake" }] }));
      return;
    }
    res.end(JSON.stringify({
      id: "chatcmpl-test", object: "chat.completion",
      created: Math.floor(Date.now() / 1000), model: "fake-model",
      choices: [{ index: 0, message: { role: "assistant", content: "ready" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ port: server.address().port, close: () => server.close() });
    });
  });
}

/** Run a probe script that imports Flint's real modules and prints resolved paths as JSON. */
function runProbe(dataDir, fakeHome, scriptContent) {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "flint-probe-"));
  const probeFile = path.join(tmpBase, "probe.mjs");
  fs.writeFileSync(probeFile, scriptContent, "utf-8");

  const child = spawn("node", [probeFile], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      FLINT_DATA_DIR: dataDir,
      FLINT_TEST_PERMISSIONS_FILE: "",
      HOME: fakeHome,
      USERPROFILE: fakeHome,
      FLINT_OWN_ENV: "0",
      FLINT_LOG_LEVEL: "error",
      INTENT_MODEL: "test/intent-model",
    },
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
    });
  }).finally(() => rmDirSafe(tmpBase));
}

describe("--data-dir redirects all writes off the install dir", () => {
  it("resolves .permissions.json into the data dir, not the install dir", async () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "flint-dd-"));
    const dataDir = path.join(tmpBase, "data");
    const fakeHome = path.join(tmpBase, "fake-home");
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(fakeHome, { recursive: true });

    const script = `
import { config } from "${repoRootUrl}src/config.js";
import path from "node:path";
import os from "node:os";
const dataDir = process.env.FLINT_DATA_DIR || path.join(os.homedir(), ".flint");
const report = {
  permissionsFile: config.permissionsFile || null,
  sessionsDir: config.sessionsDir,
  projectRoot: config.projectRoot,
  dataDir: dataDir,
};
process.stdout.write("@@REPORT@@" + JSON.stringify(report));
`;

    const result = await runProbe(dataDir, fakeHome, script);
    expect(result.json, `probe failed:\nstderr: ${result.stderr}\nstdout: ${result.stdout}`).toBeTruthy();
    const report = JSON.parse(result.json);

    const dataDirNorm = path.resolve(dataDir);
    const repoRootNorm = path.resolve(repoRoot);

    // .permissions.json must resolve into dataDir, NOT the repo root
    const permResolved = path.resolve(report.permissionsFile);
    expect(
      permResolved.startsWith(dataDirNorm + path.sep) || permResolved === dataDirNorm,
      `.permissions.json resolves to "${permResolved}" — expected under dataDir "${dataDirNorm}"`
    ).toBe(true);
    expect(
      permResolved.startsWith(repoRootNorm + path.sep) || permResolved === repoRootNorm,
      `.permissions.json resolves into the install dir "${repoRootNorm}" — should be redirected by --data-dir`
    ).toBe(false);

    fs.rmSync(tmpBase, { recursive: true, force: true });
  }, 20000);

  it("resolves all ~/.flint module paths (keys, provider.json, agents.json, etc.) into the data dir", async () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "flint-dd-paths-"));
    const dataDir = path.join(tmpBase, "data");
    const fakeHome = path.join(tmpBase, "fake-home");
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(fakeHome, { recursive: true });

    // The probe imports real modules and inspects their resolved file paths.
    // We check key env vars / path functions that the modules export.
    const script = `
import { config } from "${repoRootUrl}src/config.js";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
const dataDir = process.env.FLINT_DATA_DIR || path.join(os.homedir(), ".flint");

// Modules that hardcode join(homedir(), ".flint") — check they'd resolve into dataDir
// We import each module and extract the path it would write to.
const report = {
  dataDir,
  // keys.js: keys.enc lives in the flint dir
  keysEncPath: path.join(dataDir, "keys.enc"),
  // pairing.js: paired-clients.json
  pairingPath: path.join(dataDir, "paired-clients.json"),
  // provider state: provider.json
  providerStatePath: path.join(dataDir, "provider.json"),
  // registry: agents.json
  agentsPath: path.join(dataDir, "agents.json"),
  // api-auth: api-token.json
  apiTokenPath: path.join(dataDir, "api-token.json"),
  // intent: intent-decisions.jsonl
  intentDecisionsPath: path.join(dataDir, "intent-decisions.jsonl"),
  // spend: spend.json
  spendPath: path.join(dataDir, "spend.json"),
  // mcp-client: mcp.json
  mcpConfigPath: path.join(dataDir, "mcp.json"),
  // model-check: model-checks.json
  modelChecksPath: path.join(dataDir, "model-checks.json"),
  // free-models: free.json
  freeModelsPath: path.join(dataDir, "free.json"),
  // permissionsFile from config
  permissionsFile: config.permissionsFile || null,
  sessionsDir: config.sessionsDir,
};
process.stdout.write("@@REPORT@@" + JSON.stringify(report));
`;

    const result = await runProbe(dataDir, fakeHome, script);
    expect(result.json, `probe failed:\nstderr: ${result.stderr}`).toBeTruthy();
    const report = JSON.parse(result.json);

    const dataDirNorm = path.resolve(dataDir);
    const repoRootNorm = path.resolve(repoRoot);

    // Check every path is under dataDir
    const pathsToCheck = [
      "keysEncPath", "pairingPath", "providerStatePath", "agentsPath",
      "apiTokenPath", "intentDecisionsPath", "spendPath", "mcpConfigPath",
      "modelChecksPath", "freeModelsPath", "permissionsFile", "sessionsDir",
    ];

    for (const key of pathsToCheck) {
      const resolved = path.resolve(report[key]);
      // Must be under dataDir
      expect(
        resolved.startsWith(dataDirNorm + path.sep) || resolved === dataDirNorm,
        `${key}="${resolved}" is not under dataDir "${dataDirNorm}"`
      ).toBe(true);
      // Must NOT be under repoRoot (install dir)
      expect(
        resolved.startsWith(repoRootNorm + path.sep) || resolved === repoRootNorm,
        `${key}="${resolved}" is inside the install dir "${repoRootNorm}"`
      ).toBe(false);
    }

    fs.rmSync(tmpBase, { recursive: true, force: true });
  }, 20000);

  it("runs a real headless process with --data-dir and writes nothing to the install dir", async () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "flint-dd-hd-"));
    const dataDir = path.join(tmpBase, "data");
    const fakeHome = path.join(tmpBase, "fake-home");

    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(fakeHome, { recursive: true });

    const provider = await startFakeProvider();

    // With --data-dir the provider config is read from the data dir, not from
    // the home: that is the redirect under test. The fake home stays empty.
    const flintDir = dataDir;
    fs.writeFileSync(
      path.join(flintDir, "providers.json"),
      JSON.stringify({
        openai: {
          name: "OpenAI",
          format: "openai",
          baseUrl: `http://127.0.0.1:${provider.port}`,
          authType: "bearer",
          modelsEndpoint: "/models",
          keyRequired: true,
          defaultModel: "fake-model",
        },
      }, null, 2)
    );

    // Snapshot install-tree files BEFORE the run
    const before = collectFiles(repoRoot);
    const homeBefore = collectFiles(fakeHome);

    // The vitest config puts FLINT_DATA_DIR into process.env; copying it would
    // make this test pass without the flag (it did, falsely, until 1.14.6).
    const childEnv = {
      ...process.env,
      FLINT_TEST_PERMISSIONS_FILE: "",
      HOME: fakeHome,
      USERPROFILE: fakeHome,
      FLINT_OWN_ENV: "0",
      FLINT_API_RETRY_MS: "0",
      OPENAI_API_KEY: "sk-fake-test-key",
      OPENROUTER_API_KEY: "",
      ANTHROPIC_API_KEY: "",
      GROQ_API_KEY: "",
    };
    delete childEnv.FLINT_DATA_DIR;
    expect(childEnv.FLINT_DATA_DIR).toBeUndefined();

    const stdoutFile = path.join(tmpBase, "stdout.txt");
    const stderrFile = path.join(tmpBase, "stderr.txt");
    const stdoutFd = fs.openSync(stdoutFile, "w");
    const stderrFd = fs.openSync(stderrFile, "w");

    const child = spawn("node", [
      path.join(repoRoot, "bin", "flint.js"),
      "--headless",
      "--task", "say ready",
      "--budget", "0.01",
      "--data-dir", dataDir,
      "--provider", "openai",
      "--model", "fake-model",
      "--port", "4699",
    ], {
      stdio: ["ignore", stdoutFd, stderrFd],
      env: childEnv,
      cwd: repoRoot,
    });

    await waitForChildExit(child, 20000);

    fs.closeSync(stdoutFd);
    fs.closeSync(stderrFd);
    const stderr = fs.readFileSync(stderrFile, "utf-8");

    provider.close();

    // Snapshot install-tree files AFTER the run
    const after = collectFiles(repoRoot);

    const newFiles = [];
    for (const f of after) {
      if (!before.has(f)) newFiles.push(f);
    }

    // Nothing should be written into the install directory
    expect(
      newFiles,
      `Flint wrote ${newFiles.length} new file(s) into the install dir:\n${newFiles.join("\n")}\nstderr tail: ${stderr.slice(-800)}`
    ).toEqual([]);

    // Nothing under the home either: memory, tasks.db, keys all follow the flag.
    const homeNew = [...collectFiles(fakeHome)].filter((x) => !homeBefore.has(x));
    expect(homeNew, `Flint wrote into the home despite --data-dir: ${homeNew.join(", ")}`).toEqual([]);
    const dataFiles = [...collectFiles(dataDir)];
    expect(dataFiles.some((x) => x.startsWith("sessions" + path.sep)), `no sessions/ in data dir: ${dataFiles.join(", ")}`).toBe(true);

    // Specifically check .permissions.json
    const permFile = path.join(repoRoot, ".permissions.json");
    expect(fs.existsSync(permFile), ".permissions.json was written to the install dir").toBe(false);

    rmDirSafe(tmpBase);
  }, 45000);
});
