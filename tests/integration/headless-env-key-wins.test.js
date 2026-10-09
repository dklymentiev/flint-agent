// Integration test: in headless mode, an API key set in the environment must
// be used INSTEAD OF a key stored in encrypted storage (~/.flint/keys.enc).
//
// The real defect: config.resolveApiKey() reads storage first and only falls
// back to env when storage is empty. In a service-account / CI headless run the
// operator sets the key in the environment, but if a key is also sitting in
// encrypted storage from a previous interactive run, storage wins silently —
// and the env key is ignored even though it was the one explicitly provided.
//
// This test spawns a REAL headless process (node bin/flint.js --headless ...)
// against a local fake OpenAI-compatible provider.  It places DIFFERENT keys
// in the two sources and checks which one the provider actually receives.
//
//   - encrypted storage gets "stored-secret-key-value"
//   - OPENAI_API_KEY env var is set to "env-secret-key-value"
//   - the fake provider records the Authorization header of every request
//   - assertion: the provider must see "env-secret-key-value", never the
//     stored key.  Without the fix it sees the stored key and the test fails.
//
// stderr must also contain a one-line annotation of which source was used
// (without printing the key value itself).

import { describe, it, expect } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// -- Fake provider server -------------------------------------------------

function buildSSE(parts) {
  let body = "";
  for (const delta of parts) {
    body += `data: ${JSON.stringify({
      id: "chatcmplt-test",
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: "fake-model",
      choices: [{ index: 0, delta }],
    })}\n\n`;
  }
  body += "data: [DONE]\n\n";
  return body;
}

function startFakeProvider() {
  const requestBodies = [];
  const authHeaders = [];

  const server = http.createServer((req, res) => {
    const body = [];
    req.on("data", (chunk) => body.push(chunk));
    req.on("end", () => {
      const rawBody = Buffer.concat(body).toString("utf-8");
      let parsed = null;
      try { parsed = JSON.parse(rawBody); } catch {}
      requestBodies.push(parsed);

      // Record the auth header sent by the client
      const auth = req.headers.authorization || "";
      authHeaders.push(auth);

      if (req.url === "/chat/completions" && parsed?.stream !== true) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          id: "chatcmplt-test",
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: "fake-model",
          choices: [{ index: 0, message: { role: "assistant", content: "ready" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }));
      } else if (req.url === "/chat/completions") {
        // Streaming response for the main model call
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
        res.end(buildSSE([{ content: "ready" }], { prompt_tokens: 10, completion_tokens: 5 }));
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
        getAuthHeaders: () => authHeaders,
        getBodies: () => requestBodies,
      });
    });
  });
}

// -- Helpers --------------------------------------------------------------

const STORED_KEY = "stored-secret-key-value";
const ENV_KEY = "env-secret-key-value";

/**
 * Spawn a real headless Flint process.
 *
 * Sets up a fake HOME with:
 *   - ~/.flint/keys.enc  containing STORED_KEY for the "openai" provider
 *   - ~/.flint/providers.json overriding openai baseUrl to the fake server
 *
 * The OPENAI_API_KEY env var is set to ENV_KEY (different from STORED_KEY),
 * unless the caller passes another value: "" is the run with a stored key only.
 */
async function runHeadless(task, providerPort, { envKey = ENV_KEY } = {}) {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "flint-envkey-"));
  const dataDir = path.join(tmpBase, "flint-data");
  const workDir = path.join(tmpBase, "work");
  const fakeHome = path.join(tmpBase, "fake-home");
  const flintDir = path.join(fakeHome, ".flint");

  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(flintDir, { recursive: true });

  // Write a providers.json that overrides the openai provider to point to
  // our fake server.
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

  // The stored key goes where the CHILD looks for it: keys.enc in the child's
  // FLINT_DATA_DIR, written by a process that has the child's environment.
  //
  // The first version called setKey() in this vitest process. keys.js fixes
  // its folder at import, from this process's FLINT_DATA_DIR (set by
  // vitest.config.integration.js), so the key landed in a folder the child
  // never read. The child had no stored key at all, the environment was the
  // only source, and "the env key wins" was green with the fix removed.
  const childEnv = {
    ...process.env,
    FLINT_DATA_DIR: dataDir,
    FLINT_TEST_PERMISSIONS_FILE: path.join(tmpBase, "permissions.json"),
    HOME: fakeHome,
    USERPROFILE: fakeHome,
    FLINT_OWN_ENV: "0",
    FLINT_API_RETRY_MS: "0",
    AGENT_WORKDIR: workDir,
    INTENT_MODEL: "test/intent-model",
    OPENAI_API_KEY: envKey,
    // Other provider keys must be absent so only OPENAI_API_KEY is in play.
    OPENROUTER_API_KEY: "",
    ANTHROPIC_API_KEY: "",
  };
  const seed = spawnSync(process.execPath, [
    "--input-type=module",
    "-e",
    "const [url, key] = process.argv.slice(1);" +
      "const keys = await import(url);" +
      "await keys.setKey('openai', key);" +
      "if ((await keys.getKey('openai')) !== key) process.exit(3);",
    pathToFileURL(path.join(repoRoot, "src", "providers", "keys.js")).href,
    STORED_KEY,
  ], { env: childEnv, cwd: repoRoot, encoding: "utf-8" });
  expect(seed.status, `could not store the key for the child: ${seed.stderr}`).toBe(0);
  expect(
    fs.existsSync(path.join(dataDir, "keys.enc")),
    "the stored key is not in the folder the child reads",
  ).toBe(true);

  const stdoutFile = path.join(tmpBase, "stdout.txt");
  const stderrFile = path.join(tmpBase, "stderr.txt");
  const stdoutFd = fs.openSync(stdoutFile, "w");
  const stderrFd = fs.openSync(stderrFile, "w");

  const child = spawn("node", [
    path.join(repoRoot, "bin", "flint.js"),
    "--headless",
    "--task", task,
    "--cwd", workDir,
    "--budget", "0.01",
    "--port", "3999",
    "--provider", "openai",
    "--model", "gpt-4o",
  ], {
    stdio: ["ignore", stdoutFd, stderrFd],
    env: childEnv,
    cwd: repoRoot,
  });

  const code = await new Promise((resolve) => {
    child.on("exit", resolve);
  });

  fs.closeSync(stdoutFd);
  fs.closeSync(stderrFd);

  const stdout = fs.readFileSync(stdoutFile, "utf-8");
  const stderr = fs.readFileSync(stderrFile, "utf-8");

  return { stdout, stderr, code, tmpBase };
}

// -- Tests ----------------------------------------------------------------

describe("--headless: env var key wins over encrypted storage", () => {

  // The control. Without it the test below proves nothing: it is green
  // whenever the child cannot see the stored key, whatever the code does.
  // Here the environment holds no key, so a request that carries STORED_KEY
  // shows the stored key is real, readable and used when nothing overrides it.
  it("control: with no key in the environment the stored key is the one sent", async () => {
    const provider = await startFakeProvider();

    let result;
    try {
      result = await runHeadless("say ready for stored key control", provider.port, { envKey: "" });

      const headers = provider.getAuthHeaders();
      expect(headers.length, `no request reached the provider. stderr:
${result.stderr}`).toBeGreaterThan(0);
      for (const h of headers) {
        expect(h).toBe(`Bearer ${STORED_KEY}`);
      }
      expect(result.stderr).toContain("[key source] encrypted storage");
    } finally {
      provider.close();
      if (result?.tmpBase) {
        fs.rmSync(result.tmpBase, { recursive: true, force: true });
      }
    }
  }, 30000);

  it("uses the OPENAI_API_KEY from the environment, not the stored key", async () => {
    const provider = await startFakeProvider();

    let result;
    try {
      result = await runHeadless("say ready for env key test", provider.port);

      const headers = provider.getAuthHeaders();
      // The fake provider should have received at least one request.
      expect(headers.length).toBeGreaterThan(0);

      // The env key must be the one used — NOT the stored key.
      for (const h of headers) {
        expect(h, "provider received a request without an auth header").toMatch(/^Bearer /);
        expect(h).toBe(`Bearer ${ENV_KEY}`);
        expect(h).not.toContain(STORED_KEY);
      }
    } finally {
      provider.close();
      if (result?.tmpBase) {
        fs.rmSync(result.tmpBase, { recursive: true, force: true });
      }
    }
  }, 30000);

  it("writes a stderr annotation naming the source (environment), without printing the key", async () => {
    const provider = await startFakeProvider();

    let result;
    try {
      result = await runHeadless("say ready for stderr test", provider.port);

      // stderr names the source that was used, and says the stored key was
      // passed over. The earlier pattern also accepted "encrypted storage",
      // which is the line printed when the wrong key wins.
      expect(result.stderr, "stderr must say the environment key was used and the stored one ignored").toContain(
        "[key source] environment variable (stored key for 'openai' ignored)"
      );
      expect(result.stderr).not.toContain("[key source] encrypted storage");

      // The env key must NOT appear in stderr.
      expect(result.stderr, "the API key value must not appear in stderr").not.toContain(ENV_KEY);
      expect(result.stderr, "the stored API key value must not appear in stderr").not.toContain(STORED_KEY);
    } finally {
      provider.close();
      if (result?.tmpBase) {
        fs.rmSync(result.tmpBase, { recursive: true, force: true });
      }
    }
  }, 30000);
});
