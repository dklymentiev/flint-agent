// A damaged state file must produce a sentence, never a bare stack trace.
// Before: `flint --last` with a corrupt newest session threw a SyntaxError out
// of bootstrap() and the user got "at async bootstrap (...)" (startup matrix,
// 2026-10-08).
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function start(args, prepare) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "flint-damaged-"));
  const data = path.join(home, "data");
  fs.mkdirSync(data, { recursive: true });
  prepare(data);
  const env = { ...process.env, HOME: home, USERPROFILE: home, FLINT_DATA_DIR: data, FLINT_UPDATE_CHECK: "0", FLINT_OWN_ENV: "0" };
  for (const k of Object.keys(env)) if (/API_KEY/i.test(k)) delete env[k];
  env.OPENROUTER_API_KEY = "sk-or-v1-0123456789abcdef0123456789abcdef";
  try {
    return spawnSync(process.execPath, [path.join(ROOT, "src/index.js"), ...args], {
      encoding: "utf8", timeout: 40000, cwd: home, env, input: "", killSignal: "SIGKILL",
    });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

const damagedSessions = (data) => {
  const d = path.join(data, "sessions");
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "bad.json"), "{{{ not json");
  fs.writeFileSync(path.join(d, "empty.json"), "");
};

describe("damaged sessions", () => {
  it("--last skips an unreadable session with one line and no stack trace", () => {
    const r = start(["--last"], damagedSessions);
    expect(r.error, "it hung and was killed").toBeUndefined();
    expect(r.stderr).not.toMatch(/\n\s+at \S+ \(?(file:|node:)/);
    expect(r.stderr).not.toMatch(/SyntaxError/);
    expect(r.stderr).toMatch(/could not be read/);
  }, 60000);

  it("--session <id> says the session is corrupt, not that it is missing", () => {
    // A corrupt session is kept aside as .corrupt (session restore), so the
    // message names that instead of the generic could-not-be-read text.
    const r = start(["--session", "bad"], damagedSessions);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Session "bad" is corrupt/);
    expect(r.stderr).not.toMatch(/not found/);
  }, 60000);
});

describe("unusable state folder", () => {
  it("names the setting that fixes it", () => {
    // The data dir path is an existing FILE: mkdir under it fails with ENOTDIR.
    const r = start(["--headless", "--task", "x"], (data) => {
      fs.rmSync(data, { recursive: true });
      fs.writeFileSync(data, "not a folder");
    });
    expect(r.error, "it hung and was killed").toBeUndefined();
    expect(r.status).toBe(78);
    expect(r.stderr).toMatch(/FLINT_DATA_DIR/);
    expect(r.stderr).not.toMatch(/\n\s+at \S+ \(?(file:|node:)/);
  }, 60000);
});

describe("provider server not reachable", () => {
  it("the headless result says why, not just 'fetch failed'", async () => {
    const srv = net.createServer();
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const freePort = srv.address().port;
    await new Promise((r) => srv.close(r));
    const r = start(["--headless", "--task", "x", "--provider", "ollama"], (data) => {
      // A port nobody listens on: the Ollama server "is not running". Not 9 or 1:
      // undici refuses those as "bad port" before it tries to connect.
      const home = path.dirname(data);
      fs.mkdirSync(path.join(home, ".flint"), { recursive: true });
      const base = JSON.parse(fs.readFileSync(path.join(ROOT, "config", "providers.json"), "utf8"));
      base.ollama.baseUrl = `http://127.0.0.1:${freePort}`;
      fs.writeFileSync(path.join(home, ".flint", "providers.json"), JSON.stringify(base));
    });
    expect(r.error, "it hung and was killed").toBeUndefined();
    expect(r.stdout).toMatch(/ECONNREFUSED/);
    expect(r.stdout).toMatch(/provider ollama/);
  }, 90000);
});

describe("damaged key store", () => {
  it("says keys.enc cannot be read instead of only 'no key configured'", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "flint-keys-"));
    const data = path.join(home, "data");
    fs.mkdirSync(data, { recursive: true });
    fs.writeFileSync(path.join(data, "keys.enc"), "garbage \u0000\u00ff");
    const env = { ...process.env, HOME: home, USERPROFILE: home, FLINT_DATA_DIR: data, FLINT_UPDATE_CHECK: "0", FLINT_OWN_ENV: "0" };
    for (const k of Object.keys(env)) if (/API_KEY/i.test(k)) delete env[k];
    const r = spawnSync(process.execPath, [path.join(ROOT, "src/index.js"), "--headless", "--task", "x"], {
      encoding: "utf8", timeout: 40000, cwd: home, env, input: "", killSignal: "SIGKILL",
    });
    fs.rmSync(home, { recursive: true, force: true });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/keys\.enc cannot be read/);
    expect(r.stderr).toMatch(/No API key is configured/);
  }, 60000);
});
