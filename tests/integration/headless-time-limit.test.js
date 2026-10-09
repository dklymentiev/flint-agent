// Integration test: when a headless run has a --time-limit and the task takes
// longer than the limit, Flint must stop calling tools, print a JSON result
// with stop_reason "time", and exit with a distinct exit code (2) that the
// caller can tell apart from an error (1) and from budget exhaustion.
//
// This test spawns a REAL child process (node bin/flint.js --headless ...)
// configured to use a local fake provider. The fake provider responds slowly
// (delays its SSE stream) so the agent loop keeps working past the time limit.
//
// We then check that:
//   1. stdout contains a JSON line with stop_reason "time"
//   2. The process exited with code 2 (time limit, not error or normal)
//   3. The JSON has response, cost, tokens, and modified_files fields
//
// The fake provider uses streaming SSE and injects a deliberate delay between
// chunks so the model call takes longer than the time limit.
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
    id: "chatcmplet-test",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "fake-model",
    choices: [{ index: 0, delta: data }],
  })}\n\n`;
}

/**
 * Start a fake OpenAI-compatible provider that responds SLOWLY.
 *
 * @param {function} responseForRequest - (reqBody, isStreaming, callIndex) =>
 *   { streamingParts?: array, jsonContent?: string }
 * @param {number} chunkDelayMs - delay between each SSE chunk (simulates slow provider)
 */
function startSlowFakeProvider(responseForRequest, chunkDelayMs = 5000) {
  let requestCount = 0;
  const requestBodies = [];

  const server = http.createServer((req, res) => {
    const body = [];
    req.on("data", (chunk) => body.push(chunk));
    req.on("end", () => {
      requestCount++;
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
          // Write the first chunk immediately to start the response
          const parts = result.streamingParts || [];
          if (parts.length === 0) {
            res.end("data: [DONE]\n\n");
          } else {
            // Write each chunk with a delay to simulate a slow provider
            let i = 0;
            const writeNext = () => {
              if (i >= parts.length) {
                res.end("data: [DONE]\n\n");
                return;
              }
              res.write(sseChunk(parts[i]));
              i++;
              if (i < parts.length) {
                setTimeout(writeNext, chunkDelayMs);
              } else {
                res.end("data: [DONE]\n\n");
              }
            };
            writeNext();
          }
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
      });
    });
  });
}

/**
 * Spawns a headless Flint process configured to use the fake provider.
 */
function spawnHeadlessForTimeLimit(task, providerPort, timeLimit) {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "flint-timelimit-"));
  const dataDir = path.join(tmpBase, "flint-data");
  const workDir = path.join(tmpBase, "work");
  const fakeHome = path.join(tmpBase, "fake-home");
  const flintDir = path.join(fakeHome, ".flint");

  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(flintDir, { recursive: true });

  // Git repo in work dir so git status works
  execSync("git init", { cwd: workDir, stdio: "ignore" });
  execSync("git config user.email test@test.com", { cwd: workDir, stdio: "ignore" });
  execSync("git config user.name test", { cwd: workDir, stdio: "ignore" });

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
      "--time-limit", String(timeLimit),
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
    fs.writeFileSync(path.join(tmpBase, "spawn-error.txt"), err.message + "\n" + err.stack);
  });

  return { child, stdoutFile, stderrFile, stdoutFd, stderrFd, tmpBase, dataDir };
}

// -- Tests ----------------------------------------------------------------

describe("--headless: --time-limit stops and reports time", () => {
  // Exit code that signals "time limit" — distinct from 0 (success) and 1 (error).
  const TIME_LIMIT_EXIT_CODE = 2;

  it("stops on time limit with stop_reason 'time' and exit code 2", async () => {
    // The fake provider responds slowly: each SSE chunk takes 5 seconds.
    // With a 8-second time limit, the provider is still mid-stream when the
    // timer fires. The classifier call (non-streaming) returns immediately
    // with the intent manifest; the main model call streams slowly.
    const provider = await startSlowFakeProvider((body, isStreaming, callIdx) => {
      if (!isStreaming) {
        // Classifier: valid intent with tool access
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
      // Main model: call run_command with a long sleep. Each chunk is delayed
      // by the provider's chunkDelayMs so the whole response takes ~20s.
      return {
        streamingParts: [
          {
            tool_calls: [{
              id: "call_1",
              type: "function",
              function: {
                name: "run_command",
                arguments: JSON.stringify({ command: "sleep 120", background: false }),
              },
            }],
          },
        ],
      };
    }, 2000); // 2s between chunks → response takes ~2s+ to complete

    // 3-second time limit. The model call (streaming, 2s chunks) will not
    // have returned by the time the limit fires.
    const { child, stdoutFile, stderrFile, stdoutFd, stderrFd, tmpBase, dataDir } =
      await spawnHeadlessForTimeLimit("Do some work", provider.port, 3);

    // Wait for the process to exit. The time limit should fire before the
    // slow provider finishes responding.
    const exitCode = await new Promise((resolve) => {
      child.on("exit", (code) => resolve(code));
      // Safety: if the process doesn't exit within 20s, fail the test
      setTimeout(() => resolve(null), 20000);
    });

    // Give file system a moment to flush
    await new Promise((r) => setTimeout(r, 1000));

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
    console.log("[test] stdout:", stdout.slice(0, 800));
    console.log("[test] stderr tail:", stderr.slice(-500));

    // Cleanup
    provider.close();
    try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch {}

    // Check 1: exit code should be 2 (time limit), not 0 (success) or 1 (error)
    expect(exitCode, "process should exit with code 2 (time limit)").toBe(TIME_LIMIT_EXIT_CODE);

    // Check 2: stdout should contain JSON with stop_reason "time"
    const stdoutLines = stdout.trim().split("\n").filter((l) => l.trim());
    const jsonLine = stdoutLines.find((l) => {
      try {
        const parsed = JSON.parse(l);
        return parsed.stop_reason === "time";
      } catch {
        return false;
      }
    });
    expect(jsonLine, "stdout should contain a JSON line with stop_reason 'time'").toBeTruthy();

    if (jsonLine) {
      const parsed = JSON.parse(jsonLine);
      // Check 3: the JSON should have response, cost, and tokens
      expect(parsed.response).toBeDefined();
      expect(parsed.cost).toBeDefined();
      expect(parsed.tokens).toBeDefined();
      // Check 4: modified_files should be present
      expect(parsed.modified_files).toEqual(expect.any(Array));
    }
  }, 30000);
});
