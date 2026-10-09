// Integration test: when a headless run receives SIGTERM (e.g. from an
// external timeout), it must save the session file and print a JSON result
// to stdout with stop_reason "killed", cost, tokens, and modified files —
// BEFORE exiting.
//
// This test spawns a REAL child process (node bin/flint.js --headless ...)
// configured to use a local fake provider. The fake provider responds with a
// run_command tool call (sleep 30) so the process stays alive and we can
// send SIGTERM mid-execution.
//
// We then check that:
//   1. stdout contains a JSON line with stop_reason "killed"
//   2. The JSON has cost, tokens, and modified_files
//   3. A session file was saved in FLINT_DATA_DIR/sessions
//
// SIGTERM on Windows: Node.js supports process.on("SIGTERM") on Windows —
// the signal is emulated. child.kill("SIGTERM") works from a child process.
// The handler fires normally and the abort propagates through the agent loop.
// The killAllChildrenSync() in the handler is the safety net for child
// processes spawned via run_command, since SIGTERM may not propagate to them
// the same way on Windows as on Unix.
import { describe, it, expect, afterAll } from "vitest";
import { spawn, execSync } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// -- Fake provider server -------------------------------------------------

function sseChunk(data) {
  return `data: ${JSON.stringify({
    id: "chatcmplt-test",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "fake-model",
    choices: [{ index: 0, delta: data }],
  })}\n\n`;
}

function buildSSE(parts) {
  let body = "";
  for (const delta of parts) body += sseChunk(delta);
  body += "data: [DONE]\n\n";
  return body;
}

/**
 * Start a fake OpenAI-compatible provider.
 * @param {function} responseForRequest - (reqBody, isStreaming, callIndex) =>
 *   { streamingParts?: array, jsonContent?: string }
 */
function startFakeProvider(responseForRequest) {
  let requestCount = 0;
  const requestBodies = [];
  const requestUrls = [];

  const server = http.createServer((req, res) => {
    const body = [];
    req.on("data", (chunk) => body.push(chunk));
    req.on("end", () => {
      requestCount++;
      requestUrls.push(req.url);
      const rawBody = Buffer.concat(body).toString("utf-8");
      let parsed = null;
      try { parsed = JSON.parse(rawBody); } catch {}
      requestBodies.push(parsed);

      if (req.url === "/chat/completions") {
        const isStreaming = parsed?.stream === true;
        const result = responseForRequest(parsed, isStreaming, requestCount);

        if (isStreaming) {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
          });
          res.end(buildSSE(result.streamingParts || [{ content: "" }]));
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            id: "chatcmplet-test",
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: "fake-model",
            choices: [{
              index: 0,
              message: { role: "assistant", content: result.jsonContent || "" },
              finish_reason: "stop",
            }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }));
        }
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: [] }));
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: server.address().port,
        close: () => server.close(),
        getRequestCount: () => requestCount,
        getBodies: () => requestBodies,
        getUrls: () => requestUrls,
      });
    });
  });
}

/**
 * Spawns a headless Flint process configured to use the fake provider.
 * Returns the child process and file paths for stdout/stderr.
 */
function spawnHeadlessForSigterm(task, providerPort) {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "flint-sigterm-"));
  const dataDir = path.join(tmpBase, "flint-data");
  const workDir = path.join(tmpBase, "work");
  const fakeHome = path.join(tmpBase, "fake-home");
  const flintDir = path.join(fakeHome, ".flint");

  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(flintDir, { recursive: true });

  // Git repo in work dir so git status works
  try {
    execSync("git init", { cwd: workDir, stdio: "ignore" });
    execSync("git config user.email test@test.com", { cwd: workDir, stdio: "ignore" });
    execSync("git config user.name test", { cwd: workDir, stdio: "ignore" });
  } catch {}

  // Override the openai provider to point to our local fake server
  fs.writeFileSync(
    path.join(flintDir, "providers.json"),
    JSON.stringify({
      openai: {
        name: "OpenAI",
        format: "openai",
        baseUrl: `http://127.0.0.1:${providerPort}`,
        authType: "bearer",
        modelsEndpoint: "/models",
        keyRequired: true,
        defaultModel: "gpt-4o",
      },
    }, null, 2)
  );

  const stdoutFile = path.join(tmpBase, "stdout.txt");
  const stderrFile = path.join(tmpBase, "stderr.txt");
  const stdoutFd = fs.openSync(stdoutFile, "w");
  const stderrFd = fs.openSync(stderrFile, "w");

  const child = spawn(
    process.execPath,
    [
      path.join(repoRoot, "bin", "flint.js"),
      "--headless", "--task", task,
      "--cwd", workDir, "--budget", "0.01", "--port", "3999",
      "--provider", "openai", "--model", "gpt-4o",
    ],
    {
      stdio: ["ignore", stdoutFd, stderrFd],
      env: {
        ...process.env,
        FLINT_DATA_DIR: dataDir,
        FLINT_TEST_PERMISSIONS_FILE: path.join(tmpBase, "permissions.json"),
        HOME: fakeHome,
        USERPROFILE: fakeHome,
        FLINT_OWN_ENV: "0",
        FLINT_API_RETRY_MS: "0",
        AGENT_WORKDIR: workDir,
        OPENAI_API_KEY: "sk-fake-test-key",
        OPENROUTER_API_KEY: "",
        ANTHROPIC_API_KEY: "",
        GROQ_API_KEY: "",
      },
      cwd: repoRoot,
      windowsHide: true,
    }
  );

  child.on("error", (err) => {
    // Log spawn errors to a debug file
    fs.writeFileSync(path.join(tmpBase, "spawn-error.txt"), err.message + "\n" + err.stack);
  });

  return { child, stdoutFile, stderrFile, stdoutFd, stderrFd, tmpBase, dataDir };
}

// -- Tests ----------------------------------------------------------------

describe("--headless: SIGTERM saves session and prints result", () => {
  // On Windows, child.kill("SIGTERM") terminates the process immediately
  // without running the Node.js signal handler, so a real SIGTERM test is
  // not possible. The handler and catch-block logic are verified on Linux.
  it.skipIf(process.platform === "win32")("saves session file and prints JSON with stop_reason 'killed' on SIGTERM", async () => {
    // Start a fake provider that responds with a tool call (run_command with
    // sleep 60) to keep the process alive long enough to receive SIGTERM.
    const provider = await startFakeProvider((body, isStreaming, callIdx) => {
      if (!isStreaming) {
        // Classifier: valid intent with tools
        return {
          jsonContent: JSON.stringify({
            intent: "complex_single",
            tools: ["run_command"],
            max_steps: 150,
            assessment: "normal",
            requires_prior_tool_call: [],
          }),
        };
      }
      // Main model: call run_command with sleep 60
      return {
        streamingParts: [
          {
            tool_calls: [{
              id: "call_1",
              type: "function",
              function: {
                name: "run_command",
                arguments: JSON.stringify({ command: "sleep 60", background: false }),
              },
            }],
          },
        ],
      };
    });

    const { child, stdoutFile, stderrFile, stdoutFd, stderrFd, tmpBase, dataDir } =
      await spawnHeadlessForSigterm("Run sleep 60", provider.port);

    // Wait for the process to start up, bootstrap, call the provider, and
    // begin executing run_command (sleep 60 keeps it alive). We poll the
    // fake provider's request count instead of using a fixed sleep so the
    // SIGTERM is guaranteed to arrive while the agent loop is actually
    // running (not during bootstrap).
    await new Promise((resolve, reject) => {
      const deadline = Date.now() + 15000;
      const check = () => {
        if (provider.getRequestCount() > 0) {
          resolve();
        } else if (Date.now() > deadline) {
          reject(new Error("Provider was not called within 15s — process may not have bootstrapped"));
        } else {
          setTimeout(check, 100);
        }
      };
      check();
    });

    // Send SIGTERM — simulating an external timeout/kill
    child.kill("SIGTERM");

    // Wait for the process to exit. With the fix it should exit promptly
    // after saving the session and printing JSON.
    const exitCode = await new Promise((resolve) => {
      child.on("exit", (code) => resolve(code));
      // Safety: if the process doesn't exit within 15s, fail the test
      setTimeout(() => resolve(null), 15000);
    });

    // Give file system a moment to flush
    await new Promise((r) => setTimeout(r, 500));

    // Close file descriptors
    try { fs.closeSync(stdoutFd); } catch {}
    try { fs.closeSync(stderrFd); } catch {}

    // Read stdout and stderr
    let stdout = "";
    try { stdout = fs.readFileSync(stdoutFile, "utf-8"); } catch {}
    let stderr = "";
    try { stderr = fs.readFileSync(stderrFile, "utf-8"); } catch {}

    // Check for spawn errors
    try {
      const spawnErr = fs.readFileSync(path.join(tmpBase, "spawn-error.txt"), "utf-8");
      console.log("[test] spawnError:", spawnErr);
    } catch {}

    console.log("[test] exitCode:", exitCode);
    console.log("[test] stdout:", stdout.slice(0, 500));
    console.log("[test] stderr length:", stderr.length, "tail:", stderr.slice(-800));

    // Find session files
    const sessionsDir = path.join(dataDir, "sessions");
    let sessionFiles = [];
    try { sessionFiles = fs.readdirSync(sessionsDir).filter((f) => f.endsWith(".json")); } catch (e) {}
    console.log("[test] sessionFiles:", sessionFiles);

    // Check 1: stdout should contain JSON with stop_reason "killed"
    const stdoutLines = stdout.trim().split("\n").filter((l) => l.trim());
    const jsonLine = stdoutLines.find((l) => {
      try {
        const parsed = JSON.parse(l);
        return parsed.stop_reason === "killed";
      } catch {
        return false;
      }
    });
    expect(jsonLine, "stdout should contain a JSON line with stop_reason 'killed'").toBeTruthy();
    // A run stopped before its end exits 2, like a time limit (docs/headless-mode.md).
    expect(exitCode, "a killed run exits 2").toBe(2);

    if (jsonLine) {
      const parsed = JSON.parse(jsonLine);
      // Check 2: the JSON should have cost and tokens
      expect(parsed.cost).toBeDefined();
      expect(parsed.tokens).toBeDefined();
      // Check 3: modified_files should be present
      expect(parsed.modified_files).toEqual(expect.any(Array));
    }

    // Check 4: a session file should exist in the sessions dir
    expect(sessionFiles.length, "a session file should exist after SIGTERM").toBeGreaterThan(0);

    // Check 5: the session file should contain messages from the session
    if (sessionFiles.length > 0) {
      const sessionPath = path.join(sessionsDir, sessionFiles[0]);
      const sessionContent = JSON.parse(fs.readFileSync(sessionPath, "utf-8"));
      expect(sessionContent.messages.length).toBeGreaterThan(0);
    }

    // Cleanup — after all assertions so session files and stdout are still
    // readable when the checks above run.
    provider.close();
    try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch {}
  }, 30000);
});
