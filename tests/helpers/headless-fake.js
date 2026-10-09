// A local stand-in for the provider, and a headless Flint started against it.
//
// Shared by the headless run tests so each of them states its scenario and
// nothing else. No request leaves the machine: the openai provider is pointed
// at 127.0.0.1 through ~/.flint/providers.json in a throwaway HOME.
//
// Every response carries a usage block with a fixed price (USAGE), so a test
// can say exactly what a run of N requests must report.
import { spawn, execSync } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** What each fake request is billed, streaming or not. */
export const USAGE = Object.freeze({ prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, cost: 0.001 });

function chunk(delta, extra = {}) {
  return `data: ${JSON.stringify({
    id: "chatcmpl-test", object: "chat.completion.chunk", created: 1, model: "fake-model",
    choices: delta ? [{ index: 0, delta }] : [], ...extra,
  })}\n\n`;
}

/**
 * @param {(body: object, isStreaming: boolean, n: number) =>
 *   { streamingParts?: object[], jsonContent?: string, delayMs?: number, hang?: boolean }} respond
 *   delayMs holds the whole response back; hang never answers.
 */
export function startFakeProvider(respond) {
  const bodies = [];
  let chatRequests = 0;
  const server = http.createServer((req, res) => {
    const buf = [];
    req.on("data", (c) => buf.push(c));
    req.on("end", () => {
      let parsed = null;
      try { parsed = JSON.parse(Buffer.concat(buf).toString("utf-8")); } catch {}
      if (req.url !== "/chat/completions") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: [] }));
        return;
      }
      chatRequests++;
      bodies.push(parsed);
      const isStreaming = parsed?.stream === true;
      const r = respond(parsed, isStreaming, chatRequests) || {};
      if (r.hang) return;
      const send = () => {
        if (isStreaming) {
          res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
          let out = "";
          for (const delta of r.streamingParts || [{ content: "" }]) out += chunk(delta);
          out += chunk(null, { usage: USAGE });
          res.end(out + "data: [DONE]\n\n");
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            id: "chatcmpl-test", object: "chat.completion", created: 1, model: "fake-model",
            choices: [{ index: 0, message: { role: "assistant", content: r.jsonContent || "" }, finish_reason: "stop" }],
            usage: USAGE,
          }));
        }
      };
      if (r.delayMs) setTimeout(send, r.delayMs); else send();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({
      port: server.address().port,
      close: () => { server.closeAllConnections?.(); server.close(); },
      getRequestCount: () => chatRequests,
      getBodies: () => bodies,
    }));
  });
}

/** The classifier's answer: an intent that lets the named tools through. */
export function intent(tools, maxSteps = 5) {
  return { jsonContent: JSON.stringify({ intent: "complex_single", tools, max_steps: maxSteps, assessment: "normal", requires_prior_tool_call: [] }) };
}

/** One streamed tool call. */
export function toolCall(name, args, id = "call-1") {
  return { streamingParts: [{ content: "" }, { tool_calls: [{ id, index: 0, type: "function", function: { name, arguments: JSON.stringify(args) } }] }] };
}

/**
 * Run `flint --headless` to its end against the fake provider.
 *
 * @param {object} o
 * @param {string} o.task
 * @param {number} o.providerPort
 * @param {boolean} [o.passCwd=true] - false starts Flint FROM the work folder
 *   without --cwd, the way a person does in a terminal
 * @param {string[]} [o.extraArgs]
 * @param {(workDir: string) => void} [o.prepare] - runs in the fresh git repo
 * @param {number} [o.killAfterMs=60000] - the test's own safety net
 * @returns {Promise<{code: number|null, stdout: string, stderr: string, result: object|null, workDir: string, ms: number}>}
 */
export async function runHeadless({ task, providerPort, passCwd = true, extraArgs = [], prepare, killAfterMs = 60000 }) {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "flint-hl-"));
  const dataDir = path.join(tmpBase, "flint-data");
  const workDir = path.join(tmpBase, "work");
  const fakeHome = path.join(tmpBase, "fake-home");
  for (const d of [dataDir, workDir, path.join(fakeHome, ".flint")]) fs.mkdirSync(d, { recursive: true });
  execSync("git init", { cwd: workDir, stdio: "ignore" });
  execSync("git config user.email test@test.com", { cwd: workDir, stdio: "ignore" });
  execSync("git config user.name test", { cwd: workDir, stdio: "ignore" });
  prepare?.(workDir);
  fs.writeFileSync(path.join(fakeHome, ".flint", "providers.json"), JSON.stringify({
    openai: {
      name: "OpenAI", format: "openai", baseUrl: `http://127.0.0.1:${providerPort}`,
      authType: "bearer", modelsEndpoint: "/models", keyRequired: true, defaultModel: "fake-model",
    },
  }, null, 2));

  const stdoutFile = path.join(tmpBase, "stdout.txt");
  const stderrFile = path.join(tmpBase, "stderr.txt");
  const stdoutFd = fs.openSync(stdoutFile, "w");
  const stderrFd = fs.openSync(stderrFile, "w");
  const env = {
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
  };
  delete env.AGENT_WORKDIR;
  delete env.FLINT_LAUNCH_DIR;

  const started = Date.now();
  const child = spawn(process.execPath, [
    path.join(repoRoot, "bin", "flint.js"),
    "--headless", "--task", task,
    ...(passCwd ? ["--cwd", workDir] : []),
    "--budget", "1", "--port", "3999",
    "--provider", "openai", "--model", "fake-model",
    ...extraArgs,
  ], { stdio: ["ignore", stdoutFd, stderrFd], env, cwd: passCwd ? repoRoot : workDir, windowsHide: true });

  const code = await new Promise((resolve) => {
    const guard = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} resolve(null); }, killAfterMs);
    child.on("exit", (c) => { clearTimeout(guard); resolve(c); });
  });
  const ms = Date.now() - started;
  fs.closeSync(stdoutFd);
  fs.closeSync(stderrFd);
  const stdout = fs.readFileSync(stdoutFile, "utf-8");
  const stderr = fs.readFileSync(stderrFile, "utf-8");
  let result = null;
  for (const line of stdout.split("\n")) {
    try { const p = JSON.parse(line.trim()); if (p && typeof p === "object") result = p; } catch {}
  }
  try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch {}
  return { code, stdout, stderr, result, workDir, ms };
}
