// Integration test: headless session resume by id and concurrent-process locking.
//
// Two real headless Flint processes are spawned against an isolated FLINT_DATA_DIR
// and a fake OpenAI-compatible provider (so no real API calls are made and the
// result is deterministic on every platform).
//
//   (a) HEAD --resume by id: a session is pre-seeded; a second headless run
//       launched with --session <id> must see the earlier conversation and
//       continue it, not start fresh.
//
//   (b) LOCK --second writer refused: two headless processes that would land on
//       the same session id must not both run. The second must exit non-zero
//       with a clear "already in use" message, and crash recovery must not
//       leave a stale lock that blocks the session forever.
//
// The lock is implemented in src/sessions.js: acquireSessionLock(). The test
// targets that line — if it is removed, the second process runs and the test
// catches it.
import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// -- Fake provider server -------------------------------------------------

function sseChunk(data) {
  return `data: ${JSON.stringify({
    id: "chatcmpl-test", object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000), model: "fake-model",
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
    id: "chatcmpl-test", object: "chat.completion",
    created: Math.floor(Date.now() / 1000), model: "fake-model",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });
}

/**
 * A fake provider whose streaming reply is chosen per request by responseForRequest.
 * responseForRequest(body, callIndex) -> { streamingParts: [...] }
 */
function startFakeProvider(responseForRequest) {
  const bodies = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8");
      let parsed = null;
      try { parsed = JSON.parse(raw); } catch {}
      bodies.push(parsed);
      let result;
      try { result = responseForRequest(parsed, bodies.length, req.url); } catch (e) { result = { streamingParts: [{ content: "" }] }; }
      if (req.url === "/chat/completions") {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
        res.end(buildSSE(result.streamingParts || [{ content: "" }]));
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: [] }));
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({
      port: server.address().port,
      close: () => server.close(),
      getBodies: () => bodies,
    }));
  });
}

// -- Headless runner -------------------------------------------------------

function makeEnv(dataDir, homeDir, fakeProviderPort) {
  const flintDir = path.join(homeDir, ".flint");
  fs.mkdirSync(flintDir, { recursive: true });
  fs.writeFileSync(
    path.join(flintDir, "providers.json"),
    JSON.stringify({
      openai: {
        name: "OpenAI", format: "openai",
        baseUrl: `http://127.0.0.1:${fakeProviderPort}`,
        authType: "bearer", modelsEndpoint: "/models", keyRequired: true,
        defaultModel: "gpt-4o",
      },
    }, null, 2),
  );
  return {
    ...process.env,
    FLINT_DATA_DIR: dataDir,
    FLINT_TEST_PERMISSIONS_FILE: path.join(homeDir, "permissions.json"),
    HOME: homeDir,
    USERPROFILE: homeDir,
    FLINT_OWN_ENV: "0",
    FLINT_API_RETRY_MS: "0",
    OPENAI_API_KEY: "sk-fake-test-key",
    OPENROUTER_API_KEY: "",
    ANTHROPIC_API_KEY: "",
    GROQ_API_KEY: "",
  };
}

async function runHeadless(opts) {
  const { task, dataDir, homeDir, workDir, providerPort, extraArgs = [] } = opts;
  const stdoutFile = path.join(homeDir, "stdout.txt");
  const stderrFile = path.join(homeDir, "stderr.txt");
  const stdoutFd = fs.openSync(stdoutFile, "w");
  const stderrFd = fs.openSync(stderrFile, "w");
  const child = spawn(
    "node",
    [path.join(repoRoot, "bin", "flint.js"), "--headless",
      "--task", task, "--cwd", workDir, "--budget", "0.01", "--port", "3999",
      "--provider", "openai", "--model", "gpt-4o", ...extraArgs],
    {
      stdio: ["ignore", stdoutFd, stderrFd],
      env: makeEnv(dataDir, homeDir, providerPort),
      cwd: repoRoot,
    },
  );
  const code = await new Promise((resolve) => child.on("exit", resolve));
  fs.closeSync(stdoutFd);
  fs.closeSync(stderrFd);
  const stdout = fs.readFileSync(stdoutFile, "utf-8");
  const stderr = fs.readFileSync(stderrFile, "utf-8");
  return { code, stdout, stderr };
}

function makeTmp() {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "flint-hds-"));
  const dataDir = path.join(tmpBase, "data");
  const workDir = path.join(tmpBase, "work");
  const homeDir = path.join(tmpBase, "home");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(path.join(dataDir, "sessions"), { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });
  // git repo so auto-verify's `git status` succeeds
  try {
    const { execSync } = require("node:child_process");
    execSync("git init", { cwd: workDir, stdio: "ignore" });
    execSync("git config user.email test@test.com", { cwd: workDir, stdio: "ignore" });
    execSync("git config user.name t", { cwd: workDir, stdio: "ignore" });
  } catch {}
  return { tmpBase, dataDir, workDir, homeDir, cleanup: () => fs.rmSync(tmpBase, { recursive: true, force: true }) };
}

const SID = "test-session-resume-001";
const SYSTEM_CONTENT = "SYSTEM-MARKER-17";
const USER_CONTENT = "remember the word banana";
const SECRET = "banana";

// Seed a session file that looks like a completed prior headless run.
function seedSession(sessionsDir, id) {
  const json = JSON.stringify({
    id, model: "gpt-4o", provider: "openai", updated: "2026-01-01T00:00:00.000Z",
    cwd: "/", messages: [
      { role: "system", content: SYSTEM_CONTENT },
      { role: "user", content: USER_CONTENT },
    ], inputHistory: [USER_CONTENT], profile: "generic", plan: null,
    pastedImages: [], lastSummary: null, sessionCost: 0,
    sessionPromptTokens: 0, sessionCompletionTokens: 0,
  });
  fs.writeFileSync(path.join(sessionsDir, `${id}.json`), json, "utf-8");
  // HMAC so loadSession's integrity check passes
  const crypto = require("node:crypto");
  const keyFile = path.join(sessionsDir, ".hmac-key");
  let key;
  if (fs.existsSync(keyFile)) key = fs.readFileSync(keyFile, "utf-8").trim();
  else { key = crypto.randomBytes(32).toString("hex"); fs.writeFileSync(keyFile, key, { mode: 0o600 }); }
  const hmac = crypto.createHmac("sha256", key).update(json, "utf-8").digest("hex");
  fs.writeFileSync(path.join(sessionsDir, `${id}.hmac`), hmac, "utf-8");
}

describe("--headless: resume by --session id", () => {
  it("continues the named session instead of starting a new one", async () => {
    const t = makeTmp();
    seedSession(path.join(t.dataDir, "sessions"), SID);

    let resumeCall = null;
    const provider = await startFakeProvider((body, callIdx, url) => {
      if (url !== "/chat/completions") return { streamingParts: [{ content: "" }] };
      const msgs = body?.messages || [];
      const hasBanana = msgs.some(m => typeof m.content === "string" && m.content.includes(SECRET));
      resumeCall = { hasBanana, firstSystem: msgs[0]?.content, hasOldUser: msgs.some(m => m.role === "user" && m.content.includes("banana")) };
      return { streamingParts: [{ content: '{"intent":"chat","tools":[],"max_steps":1,"assessment":"normal","requires_prior_tool_call":[]}' }] };
    });

    try {
      const result = await runHeadless({
        task: "hello", dataDir: t.dataDir, homeDir: t.homeDir,
        workDir: t.workDir, providerPort: provider.port,
        extraArgs: ["--session", SID],
      });

      const bodies = provider.getBodies();
      // HEAD: the resumed session's history must be sent to the provider.
      // If --session is ignored, the system message is the fresh one and
      // "banana" is absent — the test fails on current code.
      expect(resumeCall, "classifier/chat was never called: run failed, stdout=" + result.stdout.slice(0, 200)).not.toBeNull();
      expect(resumeCall.hasOldUser,
        "headless did not resume the named session: the prior user message 'banana' was not sent. stdout=" + result.stdout.slice(0, 200)
      ).toBe(true);

      // The session id on disk must be the one we asked to resume, not a new timestamp.
      const files = fs.readdirSync(path.join(t.dataDir, "sessions")).filter(f => f.endsWith(".json"));
      expect(files).toContain(`${SID}.json`);
    } finally {
      provider.close();
      t.cleanup();
    }
  }, 40000);
});

describe("--headless: two processes on one session are locked out", () => {
  it("refuses the second process with a non-zero exit and a clear message", async () => {
    const t = makeTmp();

    // The fake provider returns a slow reply so both processes are running at
    // the same time long enough to collide. We use a fixed SESSION_ID via --session
    // so both target the exact same session.
    const SESSION_ID = "test-session-lock-001";
    // The fake provider returns a delayed but complete reply so the first
    // process stays running (holding the lock) long enough for the second
    // process to be refused at lock-acquisition time — before any provider
    // call is made by it.
    let providerClosed = false;
    const provider = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        if (req.url === "/models") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ data: [{ id: "gpt-4o", object: "model" }] }));
        } else if (req.url === "/chat/completions") {
          // Delay the reply so the first process holds the lock open.
          const finish = () => {
            res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
            const sse = (d) => "data: " + JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 1, model: "fake", choices: [{ index: 0, delta: d }] }) + "\n\n";
            let out = sse({ content: "ok" });
            out += "data: " + JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 1, model: "fake", choices: [{ index: 0, delta: { content: null, finish_reason: "stop" } }] }) + "\n\n";
            out += "data: [DONE]\n\n";
            res.end(out);
          };
          if (providerClosed) { finish(); } else { setTimeout(finish, 10000); }
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ data: [] }));
        }
      });
    });
    await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
    const providerPort = provider.address().port;

    const common = {
      dataDir: t.dataDir, homeDir: t.homeDir, workDir: t.workDir,
      providerPort,
    };

    try {
      // FIRST process: acquires the lock, then waits for a model reply (held open).
      const first = runHeadless({ ...common, task: "first", extraArgs: ["--session", SESSION_ID] });
      // give the first process a moment to acquire the lock
      await new Promise(r => setTimeout(r, 1500));

      // SECOND process: must be refused for the same session id.
      const second = await runHeadless({ ...common, task: "second", extraArgs: ["--session", SESSION_ID] });

      expect(second.code,
        "second process exited cleanly (no lock enforced) — stdout: " + second.stdout.slice(0, 200)
      ).toBeGreaterThan(0);
      expect(second.stderr, "no lock message in stderr").toMatch(/already in use|locked|another process/i);

      // Clean up: release the held-open provider so the first process can finish.
      provider.close();
      await first;
    } finally {
      try { provider.close(); } catch {}
      t.cleanup();
    }
  }, 40000);

  it("recovers from a stale lock left by a crashed process", async () => {
    const t = makeTmp();
    const SESSION_ID = "test-session-stale-001";

    // Simulate a crashed process: leave a stale lock file whose pid is not running.
    const sessionsDir = path.join(t.dataDir, "sessions");
    const lockPath = path.join(sessionsDir, `${SESSION_ID}.lock`);
    // A pid that is almost certainly not alive.
    const stalePid = 999999;
    fs.writeFileSync(lockPath, JSON.stringify({ pid: stalePid, startedAt: Date.now() }), "utf-8");

    let gotTask = null;
    const provider = await startFakeProvider((body) => {
      gotTask = body?.messages?.[body.messages.length - 1]?.content;
      return { streamingParts: [{ content: "ok" }] };
    });

    try {
      const result = await runHeadless({
        task: "stale-claim", dataDir: t.dataDir, homeDir: t.homeDir,
        workDir: t.workDir, providerPort: provider.port,
        extraArgs: ["--session", SESSION_ID],
      });

      // HEAD: a stale lock must not block the session — the fresh process
      // should run and exit 0.
      expect(result.code,
        "stale lock blocked the session: exit=" + result.code + " stderr=" + result.stderr.slice(0, 300)
      ).toBe(0);
      expect(gotTask, "stale-lock process did not reach the model").not.toBeNull();
    } finally {
      provider.close();
      t.cleanup();
    }
  }, 40000);

// Regression guard for the lock line: if the second process is allowed to run
// the same session, the test catches it via a non-zero exit code. On the
// current (unlocked) code the second process runs to completion (code 0) and
// the assertion fails — that is the red state this test documents.
});
