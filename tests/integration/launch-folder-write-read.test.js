// Integration test: one folder for every file tool. Flint is started from a
// project folder WITHOUT --cwd; a relative write_file, then a read_file of the
// same relative path, must both use that folder. Before, writes went to a
// per-session workspace under the data dir while reads and searches looked in
// Flint's own install folder, so the agent could not read what it had written.

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
      "--budget", "0.01", "--port", "3999",
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
      cwd: workDir,
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

describe("one folder for write and read", () => {
  it("a relative write_file lands in the launch folder and read_file finds it", async () => {
    let readResult = null;
    const provider = await startFakeProvider((body, isStreaming) => {
      if (!isStreaming) {
        return { jsonContent: JSON.stringify({ intent: "complex_multi", tools: ["write_file", "read_file"], max_steps: 10, assessment: "normal", requires_prior_tool_call: [] }) };
      }
      const messages = body?.messages || [];
      const toolMsgs = messages.filter((m) => m.role === "tool");
      const call = (id, name, args) => ({ streamingParts: [{ tool_calls: [{ id, index: 0, type: "function", function: { name, arguments: JSON.stringify(args) } }] }] });
      if (toolMsgs.length === 0) return call("call-1", "write_file", { files: [{ path: "data.csv", content: "a,b" }] });
      if (toolMsgs.length === 1) return call("call-2", "read_file", { path: "data.csv" });
      readResult = String(toolMsgs[1].content);
      return { streamingParts: [{ content: "Done." }] };
    });
    try {
      const r = await runHeadless("make data.csv and read it back", provider.port);
      expect(fs.existsSync(path.join(r.workDir, "data.csv")), "the file is in the launch folder").toBe(true);
      expect(readResult, "read_file found what write_file wrote").toContain("a,b");
    } finally {
      provider.close();
    }
  }, 120000);

  // read_file has its own fallback to the write folder, so the test above is
  // green even when the READ base still points at Flint's install folder. A
  // listing has no such fallback: "." is the read base and nothing else.
  it("a listing of \".\" shows the launch folder, with the file just written in it", async () => {
    let listResult = null;
    const provider = await startFakeProvider((body, isStreaming) => {
      if (!isStreaming) {
        return { jsonContent: JSON.stringify({ intent: "complex_multi", tools: ["write_file", "list_directory"], max_steps: 10, assessment: "normal", requires_prior_tool_call: [] }) };
      }
      const messages = body?.messages || [];
      const toolMsgs = messages.filter((m) => m.role === "tool");
      const call = (id, name, args) => ({ streamingParts: [{ tool_calls: [{ id, index: 0, type: "function", function: { name, arguments: JSON.stringify(args) } }] }] });
      if (toolMsgs.length === 0) return call("call-1", "write_file", { files: [{ path: "only-in-launch-folder.csv", content: "a,b" }] });
      if (toolMsgs.length === 1) return call("call-2", "list_directory", { path: "." });
      listResult = String(toolMsgs[1].content);
      return { streamingParts: [{ content: "Done." }] };
    });
    try {
      await runHeadless("make a file and list the folder", provider.port);
      expect(listResult, "the listing is of the launch folder").toContain("only-in-launch-folder.csv");
      expect(listResult, "the listing is of Flint's own folder").not.toContain("package.json");
    } finally {
      provider.close();
    }
  }, 120000);
});
