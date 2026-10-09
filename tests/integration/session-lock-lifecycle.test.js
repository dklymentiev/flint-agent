// Integration: the session lock is released on a clean exit, and a corrupt
// session file is kept (renamed to .corrupt) instead of being overwritten.
//
// Real headless processes against a fake OpenAI-compatible provider, same
// harness shape as headless-session-resume-lock.test.js.
import { describe, it, expect } from "vitest";
import { spawn, execSync } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function startProvider() {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (req.url === "/chat/completions") {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        const chunk = (d) => "data: " + JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 1, model: "fake", choices: [{ index: 0, delta: d }] }) + "\n\n";
        res.end(chunk({ content: "ok" }) + chunk({ content: null, finish_reason: "stop" }) + "data: [DONE]\n\n");
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "gpt-4o", object: "model" }] }));
      }
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

function makeTmp() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "flint-slc-"));
  const t = { base, dataDir: path.join(base, "data"), workDir: path.join(base, "work"), homeDir: path.join(base, "home") };
  fs.mkdirSync(path.join(t.dataDir, "sessions"), { recursive: true });
  fs.mkdirSync(t.workDir, { recursive: true });
  fs.mkdirSync(path.join(t.homeDir, ".flint"), { recursive: true });
  try { execSync("git init", { cwd: t.workDir, stdio: "ignore" }); } catch {}
  t.sessions = path.join(t.dataDir, "sessions");
  t.cleanup = () => fs.rmSync(base, { recursive: true, force: true });
  return t;
}

async function runHeadless(t, port, sessionId) {
  fs.writeFileSync(path.join(t.homeDir, ".flint", "providers.json"), JSON.stringify({
    openai: { name: "OpenAI", format: "openai", baseUrl: `http://127.0.0.1:${port}`, authType: "bearer", modelsEndpoint: "/models", keyRequired: true, defaultModel: "gpt-4o" },
  }));
  const out = path.join(t.homeDir, "out.txt");
  const err = path.join(t.homeDir, "err.txt");
  const fo = fs.openSync(out, "w");
  const fe = fs.openSync(err, "w");
  const child = spawn("node", [path.join(repoRoot, "bin", "flint.js"), "--headless", "--task", "hello", "--cwd", t.workDir,
    "--budget", "0.01", "--port", "3999", "--provider", "openai", "--model", "gpt-4o", "--session", sessionId], {
    stdio: ["ignore", fo, fe], cwd: repoRoot,
    env: { ...process.env, FLINT_DATA_DIR: t.dataDir, FLINT_TEST_PERMISSIONS_FILE: path.join(t.homeDir, "permissions.json"),
      HOME: t.homeDir, USERPROFILE: t.homeDir, FLINT_OWN_ENV: "0", FLINT_API_RETRY_MS: "0",
      OPENAI_API_KEY: "sk-fake-test-key", OPENROUTER_API_KEY: "", ANTHROPIC_API_KEY: "", GROQ_API_KEY: "" },
  });
  const code = await new Promise((r) => child.on("exit", r));
  fs.closeSync(fo); fs.closeSync(fe);
  return { code, stdout: fs.readFileSync(out, "utf-8"), stderr: fs.readFileSync(err, "utf-8") };
}

describe("session lock lifecycle (headless)", () => {
  it("removes the .lock file after a clean exit", async () => {
    const t = makeTmp();
    const provider = await startProvider();
    try {
      const r = await runHeadless(t, provider.address().port, "lock-release-001");
      expect(r.code, r.stderr.slice(0, 300)).toBe(0);
      expect(fs.existsSync(path.join(t.sessions, "lock-release-001.json"))).toBe(true);
      expect(fs.existsSync(path.join(t.sessions, "lock-release-001.lock"))).toBe(false);
    } finally {
      provider.close();
      t.cleanup();
    }
  }, 40000);

  it("keeps a corrupt session as .corrupt and says so, instead of overwriting it", async () => {
    const t = makeTmp();
    const provider = await startProvider();
    const id = "corrupt-001";
    const garbage = '{"id":"corrupt-001","messages":[{"role":"user","content":"precious history"';
    fs.writeFileSync(path.join(t.sessions, `${id}.json`), garbage);
    try {
      const r = await runHeadless(t, provider.address().port, id);
      const kept = fs.readdirSync(t.sessions).filter((f) => f.endsWith(".json.corrupt"));
      expect(kept.length, "no .corrupt file; dir=" + fs.readdirSync(t.sessions).join(",")).toBe(1);
      expect(fs.readFileSync(path.join(t.sessions, kept[0]), "utf-8")).toBe(garbage);
      expect(r.stderr + r.stdout).toMatch(/corrupt/i);
    } finally {
      provider.close();
      t.cleanup();
    }
  }, 40000);
});
