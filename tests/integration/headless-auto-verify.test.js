// Integration test: the auto-verify second-message block in headless mode
// (src/index.js, after the first processMessage call) must only fire when
// file-mutating tools were actually called in the turn.
//
//   Scenario 1 — model returns text only (no tool calls):
//     Without fix on Windows: git diff fails (2>/dev/null invalid in cmd.exe)
//     → auto-verify swallowed by catch → no second message.
//     Without fix on Linux: git diff succeeds, empty → second message fires.
//     With fix everywhere: result.toolCalls is empty → auto-verify suppressed.
//
//   Scenario 2 — model calls edit_file with bad old_text (no file changes):
//     Without fix on Windows: git diff fails → no auto-verify.
//     Without fix on Linux: git diff empty → auto-verify fires.
//     With fix everywhere: hadFileToolCall=true, git diff empty (via stdio)
//     → auto-verify fires correctly.
//
// A local HTTP server acts as the fake OpenAI-compatible provider. The
// process is configured via HOME (~/.flint/providers.json) to override the
// openai provider's baseUrl to point to the local server. OPENAI_API_KEY is
// set to a fake value so the first-run key wizard is skipped.
//
// Every request is counted and its body captured. The test fails if the
// request count doesn't match or if the process tried to reach a real
// provider (which would get 401/404 from our local server).
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
    id: "chatcmplt-test",
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
          res.end(buildJSON(result.jsonContent || ""));
        }
      } else {
        // Models endpoint etc. — return a minimal valid response
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

// -- Helpers --------------------------------------------------------------

/**
 * Spawns a headless Flint process configured to use the fake provider.
 * The openai provider is overridden in ~/.flint/providers.json to point
 * to the local server. OPENAI_API_KEY is set so the first-run wizard
 * is skipped.
 */
async function runHeadless(task, providerPort) {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "flint-av-"));
  const dataDir = path.join(tmpBase, "flint-data");
  const workDir = path.join(tmpBase, "work");
  const fakeHome = path.join(tmpBase, "fake-home");
  const flintDir = path.join(fakeHome, ".flint");

  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(flintDir, { recursive: true });

  // Git repo in work dir so `git diff --stat` succeeds (returns empty).
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
    "node",
    [
      path.join(repoRoot, "bin", "flint.js"),
      "--headless", "--task", task,
      "--cwd", workDir, "--budget", "0.01", "--port", "3999",
      "--provider", "openai", "--model", "fake-model",
    ],
    {
      stdio: ["ignore", stdoutFd, stderrFd],
      env: {
        ...process.env,
        FLINT_DATA_DIR: dataDir,
        // Own permissions file: the default is .permissions.json in the repo
        // root, shared with parallel tests, which can leave the security level
        // at "safe" and make this run deny every command.
        FLINT_TEST_PERMISSIONS_FILE: path.join(tmpBase, "permissions.json"),
        HOME: fakeHome,
        USERPROFILE: fakeHome,
        FLINT_OWN_ENV: "0",
        FLINT_API_RETRY_MS: "0",
        AGENT_WORKDIR: workDir,  // write_file writes to AGENT_WORKDIR
        OPENAI_API_KEY: "sk-fake-test-key",
        OPENROUTER_API_KEY: "",
        ANTHROPIC_API_KEY: "",
        GROQ_API_KEY: "",
      },
      cwd: repoRoot,
    }
  );

  const code = await new Promise((resolve) => {
    child.on("exit", resolve);
  });

  fs.closeSync(stdoutFd);
  fs.closeSync(stderrFd);

  const stdout = fs.readFileSync(stdoutFile, "utf-8");
  const stderr = fs.readFileSync(stderrFile, "utf-8");

  return { stdout, stderr, code, tmpBase };
}

// Helper: check if any request body contains the auto-verify message
function hasAutoVerifyMessage(bodies) {
  return bodies.some(b =>
    typeof b === "object" && b !== null &&
    JSON.stringify(b).includes("Your previous edit produced NO changes")
  );
}

// -- Tests ----------------------------------------------------------------

describe("--headless: auto-verify only fires when file tools are called", () => {

  // Scenario 1: model returns text only, no tool calls.
  // The auto-verify should NOT fire because no file-mutating tools were called.
  it("does not send auto-verify when no file tools were called", async () => {
    const provider = await startFakeProvider((body, isStreaming, callIdx) => {
      if (!isStreaming) {
        // Classifier: valid intent classification, no tools
        return {
          jsonContent: '{"intent":"chat","tools":[],"max_steps":2,"assessment":"normal","requires_prior_tool_call":[]}',
        };
      }
      // Main model: text only, no tool_calls
      return { streamingParts: [{ content: "ready" }] };
    });

    try {
      const { stdout } = await runHeadless("say ready", provider.port);

      const apiCalls = provider.getRequestCount();
      const bodies = provider.getBodies();

      // The auto-verify message should NOT appear because no file tools
      // were called in the turn.
      expect(hasAutoVerifyMessage(bodies),
        "auto-verify message was sent despite no file tool calls").toBe(false);

      // At least classifier + 1 main call (no auto-verify second call).
      // On Linux without the fix, git diff succeeds (empty) and the
      // auto-verify fires, adding a 3rd call — that's the bug.
      expect(apiCalls).toBe(2);

      // stdout should contain the "ready" response as JSON
      expect(stdout).toContain("ready");
    } finally {
      provider.close();
    }
  }, 30000);

  // Scenario 2: model calls edit_file with wrong old_text.
  // The edit fails (no changes), git diff is empty, but edit_file WAS called,
  // so auto-verify SHOULD fire.
  it("does send auto-verify when edit_file was called and no changes occurred", async () => {
    const provider = await startFakeProvider((body, isStreaming, callIdx) => {
      if (!isStreaming) {
        // Classifier: include edit_file in tools
        return {
          jsonContent: '{"intent":"chat","tools":["edit_file"],"max_steps":3,"assessment":"normal","requires_prior_tool_call":[]}',
        };
      }

      // Inspect the message history to decide which response to return.
      const messages = body?.messages || [];
      const lastMsg = messages[messages.length - 1];
      const lastContent = typeof lastMsg?.content === "string" ? lastMsg.content : "";

      // If the last message contains the auto-verify message, return a
      // final text response.
      if (lastContent.includes("Your previous edit produced NO changes")) {
        return { streamingParts: [{ content: "I see, the edit failed." }] };
      }

      // Check if there's already a tool result (edit_file was executed)
      const hasToolResult = messages.some(m => m.role === "tool");

      if (hasToolResult) {
        // Model responding to the failed edit_file tool result — text only
        return { streamingParts: [{ content: "I could not find the text to replace." }] };
      }

      // First model response: try edit_file with wrong old_text
      return {
        streamingParts: [
          { content: "" },
          {
            tool_calls: [{
              id: "call-1",
              index: 0,
              type: "function",
              function: {
                name: "edit_file",
                arguments: JSON.stringify({
                  path: "nonexistent.txt",
                  old_text: "this text does not exist",
                  new_text: "replaced",
                }),
              },
            }],
          },
        ],
      };
    });

    try {
      const { stdout } = await runHeadless("edit the nonexistent file", provider.port);

      const apiCalls = provider.getRequestCount();
      const bodies = provider.getBodies();

      // The auto-verify message SHOULD be sent because edit_file was called
      // and git diff is empty. Without the fix on Windows, git diff fails
      // (2>/dev/null is invalid in cmd.exe) so auto-verify never fires.
      expect(hasAutoVerifyMessage(bodies),
        "auto-verify should fire when edit_file was called and no changes occurred").toBe(true);

      // On Windows without the fix: 3 calls (classifier + edit_file +
      // tool-result response), no auto-verify because git diff fails.
      // With the fix: 5 calls (classifier models, main edit_file, RECOVER
      // tool-result response, auto-verify classifier, auto-verify model).
      expect(apiCalls).toBe(5);
    } finally {
      provider.close();
    }
  }, 30000);

  // Scenario 3: write_file creates a NEW (untracked) file successfully.
  // git diff --stat shows nothing for untracked files, so the old code
  // would falsely send the auto-verify message. git status --porcelain
  // DOES show untracked files, so no false positive.
  it("does not send auto-verify when write_file created a new untracked file", async () => {
    const provider = await startFakeProvider((body, isStreaming, callIdx) => {
      if (!isStreaming) {
        return {
          content: '{"intent":"chat","tools":["write_file"],"max_steps":3,"assessment":"normal","requires_prior_tool_call":[]}',
        };
      }

      const messages = body?.messages || [];
      const lastMsg = messages[messages.length - 1];
      const lastContent = typeof lastMsg?.content === "string" ? lastMsg.content : "";

      if (lastContent.includes("Your previous edit produced NO changes")) {
        // This should NOT happen in this scenario — the file was created
        return { streamingParts: [{ content: "should not be called" }] };
      }

      const hasToolResult = messages.some(m => m.role === "tool");

      if (hasToolResult) {
        // Model responding to the successful write_file result
        return { streamingParts: [{ content: "I created the file." }] };
      }

      // First model response: write_file to create a new file
      return {
        streamingParts: [
          { content: "" },
          {
            tool_calls: [{
              id: "call-1",
              index: 0,
              type: "function",
              function: {
                name: "write_file",
                arguments: JSON.stringify({
                  path: "newfile.txt",
                  content: "hello world",
                }),
              },
            }],
          },
        ],
      };
    });

    try {
      const { stdout, stderr, tmpBase } = await runHeadless(
        "create a new file",
        provider.port
      );

      const bodies = provider.getBodies();

      // The auto-verify message should NOT appear because write_file
      // successfully created a new untracked file, and git status --porcelain
      // detects it.
      expect(hasAutoVerifyMessage(bodies),
        "auto-verify fired despite write_file successfully creating a file").toBe(false);
    } finally {
      provider.close();
    }
  }, 30000);

  // Scenario 4: the model starts a long-lived process with
  // run_background_command (the tracked path). When the headless run ends,
  // that process must be dead. The process is a node script that writes its
  // own pid to a file, so it is found and checked the same way on every
  // platform (process.kill(pid, 0)), not by ps/wmic.
  it("kills a run_background_command process when headless exits", async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "flint-bg-"));
    const pidFile = path.join(scratch, "pid.txt").split(path.sep).join("/");
    const script = path.join(scratch, "long-lived.js").split(path.sep).join("/");
    fs.writeFileSync(script,
      'require("fs").writeFileSync(process.argv[2], String(process.pid)); setInterval(() => {}, 1000);');

    const waitForPidFile = () => {
      // Block the fake provider until the child is really running, so a
      // run that ends before the child starts cannot pass by accident.
      const until = Date.now() + 10000;
      while (!fs.existsSync(pidFile) && Date.now() < until) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      }
    };

    let started = false;
    const provider = await startFakeProvider((body, isStreaming) => {
      if (!isStreaming) {
        return {
          jsonContent: '{"intent":"chat","tools":["run_background_command"],"max_steps":3,"assessment":"normal","requires_prior_tool_call":[]}',
        };
      }
      const messages = body?.messages || [];
      if (messages.some(m => m.role === "tool")) {
        waitForPidFile();
        return { streamingParts: [{ content: "started it" }] };
      }
      started = true;
      return {
        streamingParts: [
          { content: "" },
          {
            tool_calls: [{
              id: "call-1", index: 0, type: "function",
              function: {
                name: "run_background_command",
                arguments: JSON.stringify({ command: `node "${script}" "${pidFile}"`, label: "long-lived" }),
              },
            }],
          },
        ],
      };
    });

    let pid = null;
    try {
      const run = await runHeadless("start a long-lived background process", provider.port);
      expect(started, "model never called run_background_command").toBe(true);
      expect(fs.existsSync(pidFile), "the background process never started; stderr: " + run.stderr.slice(-400)).toBe(true);
      pid = Number(fs.readFileSync(pidFile, "utf-8"));

      const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
      const until = Date.now() + 5000;
      while (alive() && Date.now() < until) await new Promise(r => setTimeout(r, 100));

      expect(alive(), "background process survived the headless exit").toBe(false);
    } finally {
      provider.close();
      if (pid) { try { process.kill(pid, "SIGKILL"); } catch {} }
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }, 40000);
});
