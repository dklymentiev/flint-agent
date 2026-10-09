// Starting with no terminal never waits for a person.
//
// Before (startup matrix, 2026-10-08): index.js fakes process.stdin.isTTY=true
// for ink when stdin is a pipe or /dev/null, so
//   - no key: the first-run wizard printed "Choose provider (number):" and
//     read a stdin that could not answer, with the startup watchdog lifted;
//   - a key: the "How careful should Flint be?" menu did the same.
// Both are real processes here because the defect lives in the order of
// index.js and the stdin fake, which no unit test of one function can see.
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function start(extraEnv, args = []) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "flint-noterm-"));
  const env = { ...process.env, HOME: home, USERPROFILE: home, FLINT_DATA_DIR: path.join(home, "data"), FLINT_UPDATE_CHECK: "0", FLINT_OWN_ENV: "0" };
  for (const k of Object.keys(env)) if (/API_KEY/i.test(k)) delete env[k];
  Object.assign(env, extraEnv);
  try {
    return spawnSync(process.execPath, [path.join(ROOT, "src/index.js"), ...args], {
      encoding: "utf8", timeout: 40000, cwd: home, env, input: "", killSignal: "SIGKILL",
    });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

describe("start with no terminal (empty stdin)", () => {
  it("no key: no wizard, one line saying what is missing, exit 1", () => {
    const r = start({});
    expect(r.error, "it hung and was killed").toBeUndefined();
    expect(r.status).toBe(1);
    expect(r.stdout).not.toMatch(/Choose provider/);
    expect(r.stderr).toMatch(/No API key is configured and there is no terminal/);
    expect(r.stderr).toMatch(/OPENROUTER_API_KEY/);
    expect(r.stderr).toMatch(/--model/);
  }, 60000);

  it("with a key: no careful-level menu, and the console stops saying why", () => {
    const r = start({ OPENROUTER_API_KEY: "sk-or-v1-0123456789abcdef0123456789abcdef" });
    expect(r.error, "it hung and was killed").toBeUndefined();
    expect(r.status).toBe(1);
    expect(r.stdout).not.toMatch(/How careful should Flint be/);
    expect(r.stderr).toMatch(/needs a terminal/);
  }, 60000);
});
