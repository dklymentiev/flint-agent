// Integration test: temporary/scratch files created by the model must NOT
// appear in `git status --porcelain` of the task repository (--cwd).
//
// Behavioural test: spawns a real headless Flint process and checks the
// on-disk result.
//
// The model is instructed (via the system prompt) to use /tmp/ paths for
// temporary files. normalizeTmpPath() redirects /tmp/ → os.tmpdir(), which
// keeps scratch files out of the task repository regardless of config.workdir.
//
// On HEAD (before the fix): the system prompt has no /tmp/ instruction, so the
// model has no documented scratch location — this test verifies both the
// system prompt content AND the on-disk behaviour.

import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

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

  // Git repo in work dir so we can check `git status --porcelain`.
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

// -- Tests ----------------------------------------------------------------

describe("--headless: scratch files do not pollute the task repo git status", () => {
  it("write_file with /tmp/ path does NOT appear in task repo git status", async () => {
    const provider = await startFakeProvider((body, isStreaming, callIdx) => {
      if (!isStreaming) {
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
        return { streamingParts: [{ content: "Created the scratch file." }] };
      }

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
                  path: "/tmp/flint-scratch-test-file.txt",
                  content: "hello from scratch",
                }),
              },
            }],
          },
        ],
      };
    });

    try {
      const { code, workDir } = await runHeadless(
        "Create a scratch file", provider.port
      );

      expect(code).toBe(0);

      // git status --porcelain in the task repo must be EMPTY
      const gitChanges = gitStatusPorcelain(workDir);
      expect(gitChanges,
        `git status in task repo should be empty, but found:\n${gitChanges}`
      ).toBe("");

      // The scratch file should exist in os.tmpdir(), NOT in the task repo
      const tmpFilePath = path.join(os.tmpdir(), "flint-scratch-test-file.txt");
      expect(fs.existsSync(tmpFilePath),
        `scratch file should exist in os.tmpdir() at ${tmpFilePath}`
      ).toBe(true);

      if (fs.existsSync(tmpFilePath)) {
        expect(fs.readFileSync(tmpFilePath, "utf-8")).toBe("hello from scratch");
        // Clean up
        try { fs.unlinkSync(tmpFilePath); } catch {}
      }

      // The file must NOT be in the task repo
      const fileInRepo = path.join(workDir, "flint-scratch-test-file.txt");
      expect(fs.existsSync(fileInRepo),
        "scratch file should NOT be in the task repo"
      ).toBe(false);
    } finally {
      provider.close();
    }
  }, 30000);

  it("system message instructs using /tmp/ paths for temporary files", async () => {
    // Red on HEAD: the system message must contain an explicit instruction
    // to use /tmp/ paths for temporary/scratch files, so the model knows
    // where to put them and they don't pollute the task repo.
    const { getSystemMessage } = await import("../../src/agent/system-prompt.js");

    const sysMsg = getSystemMessage(null, {});
    const msgContent = typeof sysMsg === "string" ? sysMsg : (sysMsg.content || "");

    // The system prompt must tell the agent to use /tmp/ for temp files
    // and explain that they are redirected to the system temp directory.
    const hasScratchInstruction =
      msgContent.toLowerCase().includes("/tmp") &&
      (msgContent.toLowerCase().includes("scratch") ||
       msgContent.toLowerCase().includes("temporary") ||
       msgContent.toLowerCase().includes("temp file"));

    expect(hasScratchInstruction,
      "system message should mention /tmp/ paths for scratch/temporary files"
    ).toBe(true);
  }, 10000);
});
