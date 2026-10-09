import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function startFakeProvider(handler) {
  let requestCount = 0;
  const server = http.createServer((req, res) => {
    let body = [];
    req.on("data", (c) => body.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(body).toString("utf-8");
      let parsed = {};
      try { parsed = JSON.parse(raw); } catch {}
      if (req.url === "/chat/completions") {
        requestCount++;
        let result;
        try { result = handler(parsed, requestCount); }
        catch (e) { res.writeHead(500); res.end(e.message); return; }
        if (result.streaming) {
          res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
          let sse = "";
          for (const delta of result.parts) {
            sse += `data: ${JSON.stringify({id:"t",object:"chat.completion.chunk",created:1,model:"f",choices:[{index:0,delta}]})}\n\n`;
          }
          sse += "data: [DONE]\n\n";
          res.end(sse);
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        }
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "gpt-4o", name: "gpt-4o" }] }));
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ port: server.address().port, close: () => server.close() });
    });
  });
}

async function runCheck({ providerPort, apiKey, inWorkDir = false }) {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "flint-check-"));
  const dataDir = path.join(tmpBase, "flint-data");
  const workDir = path.join(tmpBase, "work");
  const fakeHome = path.join(tmpBase, "fake-home");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(path.join(fakeHome, ".flint"), { recursive: true });

  fs.writeFileSync(path.join(fakeHome, ".flint", "providers.json"), JSON.stringify({
    openai: { name: "OpenAI", format: "openai", baseUrl: `http://127.0.0.1:${providerPort}`, authType: "bearer", modelsEndpoint: "/models", keyRequired: true, defaultModel: "gpt-4o" },
  }, null, 2));

  const stdoutFile = path.join(tmpBase, "stdout.txt");
  const stderrFile = path.join(tmpBase, "stderr.txt");
  const stdoutFd = fs.openSync(stdoutFile, "w");
  const stderrFd = fs.openSync(stderrFile, "w");

  const child = spawn(process.execPath, [path.join(repoRoot, "bin", "flint.js"), "--check", "--provider", "openai", "--model", "gpt-4o"], {
    stdio: ["ignore", stdoutFd, stderrFd],
    env: {
      ...process.env,
      FLINT_DATA_DIR: dataDir,
      FLINT_TEST_PERMISSIONS_FILE: path.join(tmpBase, "permissions.json"),
      HOME: fakeHome,
      USERPROFILE: fakeHome,
      FLINT_OWN_ENV: "0",
      FLINT_API_RETRY_MS: "0",
      OPENAI_API_KEY: apiKey,
      OPENROUTER_API_KEY: apiKey,
      ANTHROPIC_API_KEY: apiKey,
      GROQ_API_KEY: apiKey,
    },
    // inWorkDir: the probe runs commands in the folder it was started from.
    cwd: inWorkDir ? workDir : repoRoot,
  });

  const code = await new Promise((resolve) => {
    child.on("exit", resolve);
  });

  fs.closeSync(stdoutFd);
  fs.closeSync(stderrFd);

  return {
    code,
    stdout: fs.readFileSync(stdoutFile, "utf-8"),
    stderr: fs.readFileSync(stderrFile, "utf-8"),
    tmpBase,
    workDir,
  };
}

describe("headless --check flag", () => {
  it("exits 0 when key present, model answers, and tool round-trips", async () => {
    const server = await startFakeProvider((body, i) => {
      if (i === 1) return { streaming: false, choices: [{ index: 0, message: { role: "assistant", content: "", tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "run_command", arguments: JSON.stringify({ command: "node -e console.log(6*7)" }) } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
      return { streaming: false, choices: [{ index: 0, message: { role: "assistant", content: "42" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
    });

    const { code, stdout } = await runCheck({ providerPort: server.port, apiKey: "sk-fake-test-key" });
    server.close();

    expect(code).toBe(0);
    expect(stdout.trim()).toMatch(/^check ok:/);
  });

  it("exits 10 when no API key is configured", async () => {
    const server = await startFakeProvider(() => ({ streaming: false, choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));

    const { code, stderr } = await runCheck({ providerPort: server.port, apiKey: "" });
    server.close();

    expect(code).toBe(10);
    expect(stderr).toMatch(/no api key/i);
  });

  it("exits 11 when the model does not answer", async () => {
    const server = await startFakeProvider(() => {
      throw new Error("server error");
    });

    const { code } = await runCheck({ providerPort: server.port, apiKey: "sk-fake-test-key" });
    server.close();

    expect(code).toBe(11);
  });

  it("exits 12 when a tool call is made but does not round-trip", async () => {
    const server = await startFakeProvider(() => ({
      streaming: false, choices: [{ index: 0, message: { role: "assistant", content: "I cannot do that" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }));

    const { code, stdout } = await runCheck({ providerPort: server.port, apiKey: "sk-fake-test-key" });
    server.close();

    expect(code).toBe(12);
  });
  // The command comes from the model. It used to go straight to execSync: no
  // permission check, no guard, no sandbox. It now takes the path every tool
  // call takes, with nobody there to approve, so a command the guard wants
  // confirmed is refused instead of run.
  it("does not run a command the guard wants confirmed; exits 12 and says so", async () => {
    const command = `node -e "require('fs').writeFileSync('ran.txt','x')" && rm -r ./flint-check-nothing`;
    const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
    const server = await startFakeProvider((body, i) => {
      if (i === 1) return { streaming: false, choices: [{ index: 0, message: { role: "assistant", content: "", tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "run_command", arguments: JSON.stringify({ command }) } }] }, finish_reason: "tool_calls" }], usage };
      return { streaming: false, choices: [{ index: 0, message: { role: "assistant", content: "42" }, finish_reason: "stop" }], usage };
    });

    const { code, stdout, workDir } = await runCheck({ providerPort: server.port, apiKey: "sk-fake-test-key", inWorkDir: true });
    server.close();

    expect(fs.existsSync(path.join(workDir, "ran.txt")), "the command ran").toBe(false);
    expect(code).toBe(12);
    expect(stdout).toMatch(/not run|refused/i);
  });

  // Every tool call of the reply needs its own tool message, by id. Only the
  // first was answered, so a provider rejects the next request (400) and the
  // probe reported "model did not answer" (11) for a model that had answered.
  it("answers every tool call of the reply, each under its own id", async () => {
    const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
    const call = (id) => ({ index: 0, id, type: "function", function: { name: "run_command", arguments: JSON.stringify({ command: 'node -e "console.log(6*7)"' }) } });
    let secondRequest = null;
    const server = await startFakeProvider((body, i) => {
      if (i === 1) return { streaming: false, choices: [{ index: 0, message: { role: "assistant", content: "", tool_calls: [call("c1"), { ...call("c2"), index: 1 }] }, finish_reason: "tool_calls" }], usage };
      secondRequest = body;
      // What a real provider does with an unanswered tool call.
      const answered = (body.messages || []).filter((m) => m.role === "tool").map((m) => m.tool_call_id).sort();
      if (answered.join(",") !== "c1,c2") throw new Error("400: tool_call_ids did not have response messages");
      return { streaming: false, choices: [{ index: 0, message: { role: "assistant", content: "42" }, finish_reason: "stop" }], usage };
    });

    const { code, stdout } = await runCheck({ providerPort: server.port, apiKey: "sk-fake-test-key" });
    server.close();

    expect(secondRequest, "the result was never sent back").toBeTruthy();
    const toolMessages = secondRequest.messages.filter((m) => m.role === "tool");
    expect(toolMessages.map((m) => m.tool_call_id)).toEqual(["c1", "c2"]);
    for (const m of toolMessages) expect(m.content).toContain("42");
    expect(code).toBe(0);
    expect(stdout.trim()).toMatch(/^check ok:/);
  });
});
