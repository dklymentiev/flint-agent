// Integration test: in --headless --cwd, write_file with a RELATIVE path
// must land in the --cwd directory (the task repository), not in the session
// workspace. This is the SWE-bench scenario: the agent must edit files in the
// repository it was pointed at with --cwd.
//
// Red on HEAD: enterCwd no longer sets config.workdir = cwd, so resolveWritePath
// falls back through config.workdir (the session workspace from initWorkspace)
// and the relative-path file is written there instead of in --cwd.

import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// -- Fake provider server (same pattern as other headless tests) ------------

function sseChunk(data) {
  return `data: ${JSON.stringify({
    id: "chatcmplet-test",
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

// -- Headless runner --------------------------------------------------------

async function runHeadless(task, providerPort) {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "flint-cwd-"));
  const dataDir = path.join(tmpBase, "flint-data");
  const workDir = path.join(tmpBase, "work");
  const fakeHome = path.join(tmpBase, "fake-home");
  const flintDir = path.join(fakeHome, ".flint");

  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(flintDir, { recursive: true });

  // Git repo in work dir so auto-verify's `git status` works.
  try {
    execSync("git init", { cwd: workDir, stdio: "ignore" });
    execSync("git config user.email test@test.com", { cwd: workDir, stdio: "ignore" });
    execSync("git config user.name test", { cwd: workDir, stdio: "ignore" });
  } catch (e) {}

  // Override the openai provider to point to our fake server.
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
        FLINT_TEST_PERMISSIONS_FILE: path.join(tmpBase, "permissions.json"),
        HOME: fakeHome,
        USERPROFILE: fakeHome,
        FLINT_OWN_ENV: "0",
        FLINT_API_RETRY_MS: "0",
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

  return { stdout, stderr, code, tmpBase, dataDir, workDir };
}

function gitStatusPorcelain(dir) {
  try {
    return execSync("git status --porcelain", {
      cwd: dir, encoding: "utf-8", timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return "";
  }
}

// -- Tests ------------------------------------------------------------------

describe("--headless --cwd: write_file relative path lands in --cwd", () => {
  it("writes a relative-path file into the --cwd task repository", async () => {
    const provider = await startFakeProvider((body, isStreaming, callIdx) => {
      if (!isStreaming) {
        // Classifier: valid intent with write_file
        return {
          jsonContent: JSON.stringify({
            intent: "complex_multi",
            tools: ["write_file"],
            max_steps: 10,
            assessment: "normal",
            requires_prior_tool_call: [],
          }),
        };
      }

      const messages = body?.messages || [];
      const hasToolResult = messages.some(m => m.role === "tool");

      if (hasToolResult) {
        // After write_file succeeds, return final text.
        return { streamingParts: [{ content: "Created the file." }] };
      }

      // First model response: call write_file with a RELATIVE path.
      return {
        streamingParts: [
          {
            tool_calls: [{
              id: "call-1",
              index: 0,
              type: "function",
              function: {
                name: "write_file",
                arguments: JSON.stringify({
                  path: "repo-relative-file.txt",
                  content: "hello from the task repo",
                }),
              },
            }],
          },
        ],
      };
    });

    try {
      const { code, workDir } = await runHeadless(
        "Create a file called repo-relative-file.txt", provider.port
      );

      // Process should exit cleanly.
      expect(code).toBe(0);

      // The file must exist IN the --cwd task repository.
      const fileInRepo = path.join(workDir, "repo-relative-file.txt");
      expect(fs.existsSync(fileInRepo),
        `repo-relative-file.txt should exist in --cwd (${workDir})`
      ).toBe(true);

      if (fs.existsSync(fileInRepo)) {
        const content = fs.readFileSync(fileInRepo, "utf-8");
        expect(content).toBe("hello from the task repo");
      }

      // git status must show the file as a new untracked file in the repo.
      const gitChanges = gitStatusPorcelain(workDir);
      expect(gitChanges).toContain("repo-relative-file.txt");

      // The file must NOT be in the session workspace directory.
      // (config.workdir is now --cwd, so session workspace should not have it.)
      const sessionsDir = path.join(path.dirname(path.dirname(workDir)), "flint-data", "sessions");
      // sessionsDir is under dataDir which is under tmpBase
      const realSessionsDir = path.join(path.dirname(path.dirname(path.dirname(workDir))), "flint-data", "sessions");
      let sessionWorkspaceHasFile = false;
      if (fs.existsSync(realSessionsDir)) {
        const sessionDirs = fs.readdirSync(realSessionsDir)
          .filter(d => fs.statSync(path.join(realSessionsDir, d)).isDirectory());
        for (const sessionDir of sessionDirs) {
          const wsFile = path.join(realSessionsDir, sessionDir, "workspace", "repo-relative-file.txt");
          if (fs.existsSync(wsFile)) {
            sessionWorkspaceHasFile = true;
            break;
          }
        }
      }
      expect(sessionWorkspaceHasFile,
        "repo-relative-file.txt must NOT be in the session workspace — it belongs in --cwd"
      ).toBe(false);
    } finally {
      provider.close();
    }
  }, 30000);
});
