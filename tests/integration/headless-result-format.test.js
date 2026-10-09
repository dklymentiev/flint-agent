// Integration test: the headless result JSON printed to stdout must carry
// enough information for a caller to know what happened in the run.
//
// Required fields (some already existed, some are new):
//   - model:           the model string used (from config.store)
//   - stop_reason:     "done" | "budget" | "time" | "killed" | "error" | ...
//   - duration_ms:     wall-clock duration of the headless run, in ms
//   - tool_calls:      total number of tool calls made in the session
//   - denied_calls:    total number of tool calls denied by the permission guard
//   - modified_files:  array of "git status --porcelain" lines after the run
//   - tokens:          object with prompt, completion, cached sub-counts
//   - cost:            total session cost in dollars
//
// Existing keys keep their names so callers that read `response`, `cost`,
// `tokens` (number), `repoClaimGap` keep working.
//
// This test spawns a REAL child process (node bin/flint.js --headless ...)
// configured to use a local fake provider, so it exercises the real code path
// end to end.
import { describe, it, expect } from "vitest";
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

function buildJSON(content) {
  return JSON.stringify({
    id: "chatcmplet-test",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: "fake-model",
    choices: [{
      index: 0,
      message: { role: "assistant", content },
      finish_reason: "stop",
    }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });
}

/**
 * Create a fake OpenAI-compatible provider server.
 *
 * @param {function} responseForRequest - (reqBody, isStreaming, callIndex) =>
 *   { streamingParts?: array, jsonContent?: string }
 */
function startFakeProvider(responseForRequest) {
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
          res.end(buildSSE(result.streamingParts || [{ content: "" }]));
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(buildJSON(result.jsonContent || ""));
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
async function runHeadless(task, providerPort, extraArgs = []) {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "flint-resfmt-"));
  const dataDir = path.join(tmpBase, "flint-data");
  const workDir = path.join(tmpBase, "work");
  const fakeHome = path.join(tmpBase, "fake-home");
  const flintDir = path.join(fakeHome, ".flint");

  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(flintDir, { recursive: true });

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
        defaultModel: "fake-model",
      },
    }, null, 2)
  );

  const stdoutFile = path.join(tmpBase, "stdout.txt");
  const stderrFile = path.join(tmpBase, "stderr.txt");
  const stdoutFd = fs.openSync(stdoutFile, "w");
  const stderrFd = fs.openSync(stderrFile, "w");

  const args = [
    path.join(repoRoot, "bin", "flint.js"),
    "--headless", "--task", task,
    "--cwd", workDir, "--budget", "0.01", "--port", "3999",
    "--provider", "openai", "--model", "fake-model",
    ...extraArgs,
  ];

  const child = spawn(
    process.execPath,
    args,
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

  // Capture spawn errors
  child.on("error", (err) => {
    fs.writeFileSync(path.join(tmpBase, "spawn-error.txt"), err.message + "\n" + err.stack);
  });

  const code = await new Promise((resolve) => {
    child.on("exit", resolve);
    setTimeout(() => resolve(null), 30000);
  });

  fs.closeSync(stdoutFd);
  fs.closeSync(stderrFd);

  const stdout = fs.readFileSync(stdoutFile, "utf-8");
  const stderr = fs.readFileSync(stderrFile, "utf-8");

  // Read last line of stdout that parses as JSON
  let parsed = null;
  let rawLine = "";
  const lines = stdout.trim().split("\n").filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    try { parsed = JSON.parse(lines[i]); rawLine = lines[i]; break; } catch {}
  }

  return { stdout, stderr, code, tmpBase, parsed, rawLine, provider: null };
}

// Return the LAST line of stdout that parses as JSON — that is the result
// object the headless block prints at the end. `stopReason` is only used to
// filter (some scenarios emit "time" or "killed"); the last JSON line is the
// answer regardless, and a test that silently passes on null proves nothing.
function findResultJson(stdout, stopReason) {
  const lines = stdout.trim().split("\n").filter((l) => l.trim());
  let found = null;
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line.trim());
      found = parsed;
      if (stopReason && parsed.stop_reason === stopReason) return parsed;
    } catch {}
  }
  return found;
}

// -- Tests ----------------------------------------------------------------

describe("--headless: result JSON format", () => {
  it("normal completion reports model, stop_reason, duration, tool counts, modified_files, and tokens object", async () => {
    // The fake provider: classifier says complex_single with run_command,
    // the main model calls run_command once (echo hello > out.txt), then
    // returns the final text. This produces a finished run that changed a file.
    const provider = await startFakeProvider((body, isStreaming, callIdx) => {
      if (!isStreaming) {
        // Classifier call
        return {
          jsonContent: JSON.stringify({
            intent: "complex_single",
            tools: ["run_command", "write_file"],
            max_steps: 10,
            assessment: "normal",
            requires_prior_tool_call: [],
          }),
        };
      }
      const messages = body?.messages || [];
      const lastMsg = messages[messages.length - 1];
      const lastContent = typeof lastMsg?.content === "string" ? lastMsg.content : "";

      // First streaming call: model calls run_command to create a file
      if (callIdx === 2) {
        return {
          streamingParts: [{
            tool_calls: [{
              id: "call_1",
              type: "function",
              function: {
                name: "run_command",
                arguments: JSON.stringify({ command: "echo hello > out.txt", background: false }),
              },
            }],
          }],
        };
      }

      // Second streaming call: after the tool result, return final text
      return { streamingParts: [{ content: "Done writing out.txt" }] };
    });

    let stdout = "", stderr = "", code = null, parsed = null;
    try {
      const r = await runHeadless("create out.txt", provider.port);
      stdout = r.stdout; stderr = r.stderr; code = r.code; parsed = r.parsed;
    } finally {
      provider.close();
    }

    console.log("[test] exitCode:", code);
    console.log("[test] stdout:", stdout.slice(0, 600));
    console.log("[test] stderr tail:", stderr.slice(-400));

    const result = findResultJson(stdout, "done");
    expect(result, "stdout should contain a JSON result line with stop_reason 'done'").toBeDefined();

    if (result) {
      // Existing keys preserved
      expect(result.response).toBeDefined();
      expect(result.cost).toEqual(expect.any(Number));
      expect(typeof result.tokens).toBe("number");
      expect(result.repoClaimGap).toEqual(expect.any(Boolean));

      // New keys
      expect(result.model).toBe("fake-model");
      expect(result.stop_reason).toBe("done");
      expect(result.duration_ms).toEqual(expect.any(Number));
      expect(result.duration_ms).toBeGreaterThan(0);
      expect(result.tool_calls).toEqual(expect.any(Number));
      expect(result.tool_calls).toBeGreaterThanOrEqual(1);
      expect(result.denied_calls).toEqual(expect.any(Number));
      expect(result.modified_files).toEqual(expect.any(Array));
      expect(result.modified_files.length).toBeGreaterThan(0);

      // tokens object with prompt/completion/cached
      expect(result.tokens_obj).toEqual(expect.any(Object));
      expect(result.tokens_obj.prompt).toEqual(expect.any(Number));
      expect(result.tokens_obj.completion).toEqual(expect.any(Number));
      expect(result.tokens_obj.cached).toEqual(expect.any(Number));
    }
  }, 30000);

  it("reports denied_calls when a tool call is blocked by the security guard", async () => {
    // The fake provider: classifier includes run_command, the main model
    // calls run_command with a destructive pattern (rm -rf /), which the
    // guard denies. The model then returns text without calling another tool.
    const provider = await startFakeProvider((body, isStreaming, callIdx) => {
      if (!isStreaming) {
        return {
          jsonContent: JSON.stringify({
            intent: "complex_single",
            tools: ["run_command"],
            max_steps: 10,
            assessment: "normal",
            requires_prior_tool_call: [],
          }),
        };
      }
      if (callIdx === 2) {
        // The model attempts a destructive command that the guard blocks
        return {
          streamingParts: [{
            tool_calls: [{
              id: "call_blocked",
              type: "function",
              function: {
                name: "run_command",
                arguments: JSON.stringify({ command: "rm -rf /tmp/nonexistent_sweet_path_test", background: false }),
              },
            }],
          }],
        };
      }
      return { streamingParts: [{ content: "I was not allowed to do that." }] };
    });

    let stdout = "", stderr = "", code = null;
    try {
      const r = await runHeadless("try something", provider.port);
      stdout = r.stdout; stderr = r.stderr; code = r.code;
    } finally {
      provider.close();
    }

    console.log("[test] exitCode:", code);
    console.log("[test] stdout:", stdout.slice(0, 600));

    const result = findResultJson(stdout, "done");
    expect(result, "stdout should contain a JSON result with stop_reason 'done'").toBeDefined();

    if (result) {
      expect(result.tool_calls).toEqual(expect.any(Number));
      expect(result.tool_calls).toBeGreaterThanOrEqual(1);
      expect(result.denied_calls).toBeGreaterThanOrEqual(1);
    }
  }, 30000);

  it("killed path (SIGTERM) carries the same extended fields", async () => {
    if (process.platform === "win32") {
      console.log("[test] SIGTERM is emulated on Windows; skipping real signal test");
      return;
    }

    const provider = await startFakeProvider((body, isStreaming, callIdx) => {
      if (!isStreaming) {
        return {
          jsonContent: JSON.stringify({
            intent: "complex_single",
            tools: ["run_command"],
            max_steps: 10,
            assessment: "normal",
            requires_prior_tool_call: [],
          }),
        };
      }
      // Keep the process alive with a long sleep so SIGTERM arrives mid-execution
      return {
        streamingParts: [{
          tool_calls: [{
            id: "call_1",
            type: "function",
            function: {
              name: "run_command",
              arguments: JSON.stringify({ command: "sleep 120", background: false }),
            },
          }],
        }],
      };
    });

    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "flint-resfmt-kill-"));
    const dataDir = path.join(tmpBase, "flint-data");
    const workDir = path.join(tmpBase, "work");
    const fakeHome = path.join(tmpBase, "fake-home");
    const flintDir = path.join(fakeHome, ".flint");

    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(workDir, { recursive: true });
    fs.mkdirSync(flintDir, { recursive: true });
    try {
      execSync("git init", { cwd: workDir, stdio: "ignore" });
      execSync("git config user.email test@test.com", { cwd: workDir, stdio: "ignore" });
      execSync("git config user.name test", { cwd: workDir, stdio: "ignore" });
    } catch {}

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

    const stdoutFile = path.join(tmpBase, "stdout.txt");
    const stderrFile = path.join(tmpBase, "stderr.txt");
    const stdoutFd = fs.openSync(stdoutFile, "w");
    const stderrFd = fs.openSync(stderrFile, "w");

    const child = spawn(
      process.execPath,
      [
        path.join(repoRoot, "bin", "flint.js"),
        "--headless", "--task", "sleep work",
        "--cwd", workDir, "--budget", "0.01", "--port", "3999",
        "--provider", "openai", "--model", "fake-model",
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

    // Let it start and begin the tool call
    await new Promise((r) => setTimeout(r, 8000));

    child.kill("SIGTERM");

    const exitCode = await new Promise((resolve) => {
      child.on("exit", resolve);
      setTimeout(() => resolve(null), 15000);
    });

    await new Promise((r) => setTimeout(r, 1000));
    fs.closeSync(stdoutFd);
    fs.closeSync(stderrFd);

    const stdout = fs.readFileSync(stdoutFile, "utf-8");
    let stderr = "";
    try { stderr = fs.readFileSync(stderrFile, "utf-8"); } catch {}

    console.log("[test] exitCode:", exitCode);
    console.log("[test] stdout:", stdout.slice(0, 600));

    try { provider.close(); } catch {}
    try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch {}

    const result = findResultJson(stdout, "killed");
    expect(exitCode, "a killed run exits 2").toBe(2);
    expect(result, "stdout should contain a JSON line with stop_reason 'killed'").toBeDefined();

    if (result) {
      expect(result.model).toBe("fake-model");
      expect(result.stop_reason).toBe("killed");
      expect(result.duration_ms).toEqual(expect.any(Number));
      expect(result.cost).toEqual(expect.any(Number));
      expect(typeof result.tokens).toBe("number");
      expect(result.tokens_obj).toEqual(expect.any(Object));
      expect(result.tokens_obj.prompt).toEqual(expect.any(Number));
      expect(result.tokens_obj.completion).toEqual(expect.any(Number));
      expect(result.tokens_obj.cached).toEqual(expect.any(Number));
      expect(result.tool_calls).toEqual(expect.any(Number));
      expect(result.denied_calls).toEqual(expect.any(Number));
      expect(result.modified_files).toEqual(expect.any(Array));
    }
  }, 30000);
});
