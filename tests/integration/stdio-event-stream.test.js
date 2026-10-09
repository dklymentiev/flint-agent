// Integration test: the stdio mode emits a machine-readable event stream that
// lets a node host observe live steps.
//
// A real subprocess is spawned (bin/flint.js --stdio) with a mock OpenAI-compatible
// provider that replies with a tool call. The test asserts that stdout carries:
//
//   1. A tool_start event when a tool begins (with name + args).
//   2. A tool_result event that includes the tool name and a duration.
//   3. Streamed text tokens (not just the final assembled reply).
//   4. A turn result event with stop_reason.
//
// See docs/findings/stdio-event-stream.md for the investigation that motivated
// these assertions.

import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, realpathSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function startMockServer(port) {
  let mockCallCount = 0;
  const server = http.createServer((req, res) => {
    if (req.url === "/v1/models") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "mock-model" }] }));
      return;
    }
    if (req.url === "/chat/completions") {
      mockCallCount++;
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        const parsed = JSON.parse(body);
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Transfer-Encoding": "chunked",
          "Cache-Control": "no-cache",
        });

        if (mockCallCount === 1) {
          // First reply: text + a tool call
          const id = "chatcmpl-test-1";
          const model = "mock-model";
          res.write('data: ' + JSON.stringify({ id, model, object: "chat.completion.chunk", created: Date.now(), choices: [{ index: 0, delta: { content: "Looking up" } }] }) + '\n\n');
          res.write('data: ' + JSON.stringify({ id, model, object: "chat.completion.chunk", created: Date.now(), choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "run_command", arguments: "" } }] } }] }) + '\n\n');
          res.write('data: ' + JSON.stringify({ id, model, object: "chat.completion.chunk", created: Date.now(), choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"command":"echo hello from tool"}' } }] } }] }) + '\n\n');
          res.write('data: ' + JSON.stringify({ id, model, usage: { prompt_tokens: 10, completion_tokens: 8 } }) + '\n\n');
          res.write('data: [DONE]\n\n');
          res.end();
        } else {
          // Second reply: final text
          const id = "chatcmpl-test-2";
          res.write('data: ' + JSON.stringify({ id, model: "mock-model", object: "chat.completion.chunk", created: Date.now(), choices: [{ index: 0, delta: { content: "The tool says hello." } }] }) + '\n\n');
          res.write('data: ' + JSON.stringify({ id, model: "mock-model", usage: { prompt_tokens: 30, completion_tokens: 5 } }) + '\n\n');
          res.write('data: [DONE]\n\n');
          res.end();
        }
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });

  return {
    listen: () => new Promise((resolve) => {
      if (port) {
        server.listen(port, "127.0.0.1", resolve);
      } else {
        server.listen(0, "127.0.0.1", resolve);
      }
    }),
    address: () => server.address(),
    close: () => new Promise((resolve) => server.close(resolve)),
    get count() { return mockCallCount; },
  };
}

describe("stdio mode event stream", () => {
  it("emits tool_start, tool_result with duration, streaming text, and stop_reason", async () => {
    const agentDir = realpathSync(mkdtempSync(path.join(tmpdir(), "flint-stdio-event-agent-")));
    const dataDir = mkdtempSync(path.join(tmpdir(), "flint-stdio-event-data-"));
    const flintHome = mkdtempSync(path.join(tmpdir(), "flint-stdio-event-home-"));

    // Provider config pointing at the mock server
    const server = startMockServer(0);
    await server.listen();
    const actualPort = server.address().port;

    // Write providers.json into ~/.flint/ of the sandbox home
    const flintConfigDir = path.join(flintHome, ".flint");
    mkdirSync(flintConfigDir, { recursive: true });
    writeFileSync(path.join(flintConfigDir, "providers.json"), JSON.stringify({
      "local-mock": {
        "name": "Mock",
        "format": "openai",
        "baseUrl": `http://127.0.0.1:${actualPort}`,
        "authType": "none",
        "keyRequired": false,
        "defaultModel": "mock-model"
      }
    }));

    writeFileSync(path.join(agentDir, "CLAUDE.md"), "You are a test agent.");

    const child = spawn(process.execPath, [
      path.join(ROOT, "bin", "flint.js"),
      "--stdio",
      "--model", "mock-model",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--session-id", "event-stream-test",
    ], {
      cwd: agentDir,
      env: {
        ...process.env,
        FLINT_DATA_DIR: dataDir,
        HOME: flintHome,
        USERPROFILE: flintHome,
        FLINT_PROVIDER: "local-mock",
        INTENT_MODEL: "test/intent-model",
        FLINT_OWN_ENV: "0",
        AGENT_API_TIMEOUT: "30",
        AGENT_MAX_ITERATIONS: "10",
        MCP_SERVERS: "",
        PATH: process.env.PATH,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stdoutLines = [];
    const stderrLines = [];
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (data) => {
      for (const line of data.split("\n")) {
        if (line.trim()) stdoutLines.push(line);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (data) => { stderrLines.push(String(data)); });

    // Wait for init
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`no init in 30s; stderr: ${stderrLines.join("").slice(0, 500)}`)), 30000);
      child.stdout.on("data", () => {
        if (stdoutLines.some((l) => { try { return JSON.parse(l).type === "system" && JSON.parse(l).subtype === "init"; } catch { return false; } })) {
          clearTimeout(t);
          resolve();
        }
      });
      child.on("exit", (code) => {
        clearTimeout(t);
        reject(new Error(`process exited early code=${code}; stderr: ${stderrLines.join("").slice(0, 1000)}`));
      });
    });

    // Send a user message that triggers a tool call
    child.stdin.write(JSON.stringify({
      type: "user",
      message: { content: "echo hello from tool" }
    }) + "\n");

    // Wait for result
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`no result in 25s; stdout: ${stdoutLines.map(l => l.slice(0,80)).join(" | ")}`)), 25000);
      const iv = setInterval(() => {
        const hasResult = stdoutLines.some((l) => {
          try { const p = JSON.parse(l); return p.type === "result"; } catch { return false; }
        });
        if (hasResult) {
          clearTimeout(t);
          clearInterval(iv);
          resolve();
        }
      }, 200);
      child.on("exit", () => { clearTimeout(t); clearInterval(iv); resolve(); });
    });

    child.stdin.end();
    await new Promise((r) => setTimeout(r, 500));
    try { child.kill(); } catch {}
    await server.close();

    const events = stdoutLines
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);

    const stderrText = stderrLines.join("");

    // Clean up temp dirs
    for (const d of [agentDir, dataDir, flintHome]) {
      try { rmSync(d, { recursive: true, force: true }); } catch {}
    }

    // --- Assertions ---

    // 1. System init
    const init = events.find((e) => e.type === "system");
    expect(init, "should have init event").toBeTruthy();

    // 2. Tool-start event: a tool began before its result
    const toolStart = events.find((e) => e.type === "tool_start");
    expect(toolStart, "should emit a tool_start event").toBeTruthy();
    if (toolStart) {
      expect(toolStart.tool_name).toBeTruthy();
      expect(toolStart.args).toBeTruthy();
    }

    // 3. Tool-result event includes the tool name and a duration
    const toolResult = events.find((e) => e.type === "user" && e.message?.content?.[0]?.type === "tool_result");
    expect(toolResult, "should have a tool_result event").toBeTruthy();
    if (toolResult) {
      expect(toolResult.tool_name, "tool_result should carry the tool name").toBeTruthy();
      expect(toolResult.duration_ms, "tool_result should have a duration_ms").toBeGreaterThanOrEqual(0);
    }

    // 4. Streaming text: tokens arrive before the final assistant event
    const streamEvents = events.filter((e) => e.type === "text");
    expect(streamEvents.length, "should emit streaming text events").toBeGreaterThan(0);

    // 5. Result event has stop_reason
    const result = events.find((e) => e.type === "result");
    expect(result, "should have a result event").toBeTruthy();
    if (result) {
      expect(result.stop_reason, "result should carry stop_reason").toBeTruthy();
    }
  }, 60000);
});
