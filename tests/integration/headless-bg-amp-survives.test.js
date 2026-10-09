// Integration test: a command launched with `&` (backgrounded in the shell)
// inside run_command must not survive the headless process exit.
//
// The defect: `sleep 300 > /dev/null 2>&1 & echo marker` inside run_command
// — the shell forks sleep as a child, prints "marker", and exits. sleep is
// reparented to PID 1 and keeps running. When the headless run calls
// process.exit(0), killAllChildrenSync() walks activeChildren, but the bash
// entry was already removed on "close"; sleep is an orphan nobody tracks.
//
// The test spawns a REAL headless process with a fake provider. The model
// calls run_command with `sleep` backgrounded via `&`. The child writes its
// own PID to a file so it is found and checked the same way on every platform
// via process.kill(pid, 0) — not ps / wmic. After the headless process exits,
// the test asserts the orphaned PID is dead.
import { describe, it, expect } from "vitest";
import { spawn, execSync } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

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
    id: "chatcmpletion-test",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: "fake-model",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });
}

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
          res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
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

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/**
 * Spawn a headless Flint that uses the fake provider. The openai provider is
 * overridden in ~/.flint/providers.json to point to the local server.
 */
async function runHeadlessWithAmp(providerPort, scratch) {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "flint-amp-"));
  const dataDir = path.join(tmpBase, "flint-data");
  const workDir = path.join(tmpBase, "work");
  const fakeHome = path.join(tmpBase, "fake-home");
  const flintDir = path.join(fakeHome, ".flint");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(flintDir, { recursive: true });

  // Git init so run_command has a repo (some code paths call git).
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

  // A tiny script that writes its own PID and then sleeps forever.
  // The PID is how we identify the orphaned process on both Windows and Linux.
  const script = path.join(scratch, "sleeper.js");
  const pidFile = path.join(scratch, "pid.txt").split(path.sep).join("/");
  fs.writeFileSync(script,
    'require("fs").writeFileSync(process.argv[2], String(process.pid)); setInterval(() => {}, 1000);');

  // The command the model will run: launch the sleeper in the background
  // with `&`, then echo a marker so run_command returns.
  const ampCommand = `node "${script}" "${pidFile}" > /dev/null 2>&1 & echo marker`;

  const stdoutFile = path.join(tmpBase, "stdout.txt");
  const stderrFile = path.join(tmpBase, "stderr.txt");
  const stdoutFd = fs.openSync(stdoutFile, "w");
  const stderrFd = fs.openSync(stderrFile, "w");

  let started = false;
  const child = spawn(
    "node",
    [
      path.join(repoRoot, "bin", "flint.js"),
      "--headless", "--task", "start a backgrounded process",
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
        AGENT_SHELL: process.platform === "win32"
          ? "C:\\Program Files\\Git\\usr\\bin\\bash.exe"
          : "/bin/bash",
      },
      cwd: repoRoot,
    }
  );

  // Wire the fake provider to actually call run_command with `&`.
  const provider = await startFakeProvider((body, isStreaming, callIdx) => {
    if (!isStreaming) {
      // In headless mode the classifier is bypassed, but the API client may
      // still make a non-streaming call. Return a minimal JSON.
      return { jsonContent: '{"intent":"chat","tools":["run_command"],"max_steps":3}' };
    }
    const messages = body?.messages || [];
    // Once we see a tool result, the model has done its job.
    if (messages.some(m => m.role === "tool")) {
      started = true;
      return { streamingParts: [{ content: "background started" }] };
    }
    return {
      streamingParts: [
        { content: "" },
        {
          tool_calls: [{
            id: "call-1",
            index: 0,
            type: "function",
            function: {
              name: "run_command",
              arguments: JSON.stringify({ command: ampCommand }),
            },
          }],
        },
      ],
    };
  });

  const code = await new Promise((resolve) => { child.on("exit", resolve); });
  provider.close();
  fs.closeSync(stdoutFd);
  fs.closeSync(stderrFd);
  const stdout = fs.readFileSync(stdoutFile, "utf-8");
  const stderr = fs.readFileSync(stderrFile, "utf-8");

  return { stdout, stderr, code, pidFile, started, tmpBase };
}

describe("--headless: & background processes do not survive exit", () => {
  it("kills a run_command process that used & when headless exits", async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "flint-amp-scratch-"));

    let pid = null;
    let result;
    try {
      // We need the provider port before spawning the headless process.
      // Create the provider first, then spawn.
      const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "flint-amp-"));
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

      // A tiny script that writes its own PID and then sleeps forever.
      const script = path.join(scratch, "sleeper.js");
      const pidFile = path.join(scratch, "pid.txt").split(path.sep).join("/");
      fs.writeFileSync(script,
        'require("fs").writeFileSync(process.argv[2], String(process.pid)); setInterval(() => {}, 1000);');
      const ampCommand = `node "${script}" "${pidFile}" > /dev/null 2>&1 & echo marker`;

      let started = false;
      const provider = await startFakeProvider((body, isStreaming, callIdx) => {
        if (!isStreaming) {
          return { jsonContent: '{"intent":"chat","tools":["run_command"],"max_steps":3}' };
        }
        const messages = body?.messages || [];
        if (messages.some(m => m.role === "tool")) {
          started = true;
          return { streamingParts: [{ content: "background started" }] };
        }
        return {
          streamingParts: [
            { content: "" },
            {
              tool_calls: [{
                id: "call-1",
                index: 0,
                type: "function",
                function: {
                  name: "run_command",
                  arguments: JSON.stringify({ command: ampCommand }),
                },
              }],
            },
          ],
        };
      });

      // Override the openai provider to point to our local fake server
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
          "--headless", "--task", "start a backgrounded process",
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
            AGENT_SHELL: process.platform === "win32"
              ? "C:\\Program Files\\Git\\usr\\bin\\bash.exe"
              : "/bin/bash",
          },
          cwd: repoRoot,
        }
      );

      const code = await new Promise((resolve) => { child.on("exit", resolve); });
      provider.close();
      fs.closeSync(stdoutFd);
      fs.closeSync(stderrFd);
      const stdout = fs.readFileSync(stdoutFile, "utf-8");
      const stderr = fs.readFileSync(stderrFile, "utf-8");
      result = { stdout, stderr, code, pidFile, started, tmpBase };
    } finally {
      if (result?.pidFile && fs.existsSync(result.pidFile)) {
        pid = Number(fs.readFileSync(result.pidFile, "utf-8"));
      }
      // Wait a moment for the process to be reparented and potentially killed.
      const until = Date.now() + 5000;
      while (pid && alive(pid) && Date.now() < until) {
        await new Promise(r => setTimeout(r, 100));
      }
    }

    expect(result.started, "model never called run_command; stderr: " + (result.stderr || "").slice(-600)).toBe(true);
    expect(fs.existsSync(result.pidFile),
      "the backgrounded process never wrote its PID").toBe(true);

    expect(alive(pid),
      "a process started with `&` survived the headless exit (pid " + pid + ")"
    ).toBe(false);

    // Cleanup
    if (pid) { try { process.kill(pid, "SIGKILL"); } catch {} }
    fs.rmSync(scratch, { recursive: true, force: true });
    if (result?.tmpBase) fs.rmSync(result.tmpBase, { recursive: true, force: true });
  }, 60000);
});
