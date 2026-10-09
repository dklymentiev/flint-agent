// Integration test: headless mode must not start an HTTP server, and its
// stdout/stderr must be clean for machine parsing.
//
// This test spawns a REAL child process:
//   node bin/flint.js --headless --task "..." --cwd <temp> --budget N --port <port>
// with its own FLINT_DATA_DIR and HOME, and observes the result from outside:
//
//   Point 2: no TCP port is opened during the run.
//   Point 3: stdout contains at most one line of JSON; stderr contains
//            no ANSI escape sequences, no spinner frames, no terminal
//            reset codes.
//
// The process is launched with a fake API key and HOME pointing to an empty
// temp directory. The keys.js module reads encrypted keys from homedir()/.flint,
// NOT from FLINT_DATA_DIR, so we override HOME to prevent the child from
// picking up the developer's real stored API key. The API call will fail
// (401 or network error) — that is expected and costs nothing. What matters
// is the infrastructure around the task run: server guard, output format,
// stderr cleanliness.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "flint-hd-io-"));
const dataDir = path.join(tmpBase, "flint-data");
const workDir = path.join(tmpBase, "work");
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(workDir, { recursive: true });

afterAll(() => {
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

// Find a free port to use for the --port flag. We verify the child does NOT
// listen on it.
const PORT = await new Promise((resolve) => {
  const srv = net.createServer();
  srv.listen(0, "127.0.0.1", () => {
    const p = srv.address().port;
    srv.close(() => resolve(p));
  });
});

// Check if a specific port is accepting connections.
async function isPortOpen(port) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 100);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    socket.connect(port, "127.0.0.1");
  });
}

// Spawns a headless Flint process once and returns its stdout, stderr,
// exit code, and whether the port was opened during the run.
//
// Environment is passed EXPLICITLY to the child. The key fix for the network
// issue: HOME is overridden to the temp directory so keys.js (which reads from
// homedir()/.flint/keys.enc, NOT from FLINT_DATA_DIR) finds no stored keys.
// OPENROUTER_API_KEY is set to a fake value that never matches a real server.
async function runHeadlessOnce(task, budget = 0.01) {
  const stdoutFile = path.join(tmpBase, `stdout-${Date.now()}.txt`);
  const stderrFile = path.join(tmpBase, `stderr-${Date.now()}.txt`);
  const stdoutFd = fs.openSync(stdoutFile, "w");
  const stderrFd = fs.openSync(stderrFile, "w");

  const child = spawn("node", [
    path.join(repoRoot, "bin", "flint.js"),
    "--headless",
    "--task", task,
    "--cwd", workDir,
    "--budget", String(budget),
    "--port", String(PORT),
  ], {
    stdio: ["ignore", stdoutFd, stderrFd],
    // Pass the environment explicitly. HOME is overridden to the temp
    // directory so the child cannot find real stored API keys.
    env: {
      ...process.env,
      FLINT_DATA_DIR: dataDir,
      HOME: tmpBase,
      USERPROFILE: tmpBase,
      OPENROUTER_API_KEY: "sk-fake-headless-test-no-real-calls-here",
      INTENT_MODEL: "test/intent-model",
      FLINT_OWN_ENV: "0",
      // Clear any provider-specific env vars that might contain real keys
      OPENAI_API_KEY: "",
      GROQ_API_KEY: "",
      ANTHROPIC_API_KEY: "",
    },
    cwd: repoRoot,
  });

  // Probe the port while the process runs.
  let portWasOpen = false;
  const probeInterval = setInterval(async () => {
    if (await isPortOpen(PORT)) portWasOpen = true;
  }, 100);

  const code = await new Promise((resolve) => {
    child.on("exit", resolve);
  });
  clearInterval(probeInterval);

  // Final check after exit.
  const portOpenAfterExit = await isPortOpen(PORT);

  fs.closeSync(stdoutFd);
  fs.closeSync(stderrFd);

  const stdout = fs.readFileSync(stdoutFile, "utf-8");
  const stderr = fs.readFileSync(stderrFile, "utf-8");

  return {
    stdout,
    stderr,
    code,
    portOpenDuringRun: portWasOpen,
    portOpenAfterExit: portOpenAfterExit,
  };
}

describe("--headless: no HTTP server and clean output (points 2 & 3)", () => {
  // Spawn the child process ONCE and reuse the result for all assertions.
  let result;
  beforeAll(async () => {
    result = await runHeadlessOnce("say ready", 0.01);
  }, 30000);

  it("does not open any TCP port during the run or after exit", () => {
    // Point 2: no port should be open at any point — headless mode has no
    // API server to serve.
    expect(result.portOpenDuringRun, "a TCP port was opened during the headless run").toBe(false);
    expect(result.portOpenAfterExit, "a TCP port was still open after the process exited").toBe(false);
  });

  it("stdout is empty (on error) or exactly one JSON line", () => {
    // Point 3: stdout must be either empty (when the task fails, e.g. 401)
    // or a single line of JSON (when the task succeeds). It must NOT contain
    // escape sequences, spinner frames, or banners.
    if (result.stdout.trim()) {
      const lines = result.stdout.trim().split("\n");
      expect(lines.length).toBe(1);
      expect(() => JSON.parse(lines[0])).not.toThrow();
    }
  });

  it("stderr contains no ANSI escape sequences or spinner frames", () => {
    // Point 3: stderr must not contain control sequences, spinner frames
    // (the Unicode braille characters), or terminal reset codes.
    // Clean error messages only.
    const hasEsc = result.stderr.includes("\x1b");
    // The spinner writes "\r${_mark1}   ${frame} loading..." to stderr.
    // We check for the spinner pattern specifically.
    const hasSpinner = result.stderr.includes("loading...") ||
      /[\u2800-\u28FF]/.test(result.stderr); // Braille pattern area
    expect(hasEsc, "stderr contains ANSI escape sequences").toBe(false);
    expect(hasSpinner, "stderr contains spinner frames").toBe(false);
  });
});
