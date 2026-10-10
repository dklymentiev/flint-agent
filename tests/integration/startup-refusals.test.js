// Two starts that used to end badly on a server, both run here as a REAL
// process (node bin/flint.js) with stdin that is not a terminal:
//
//   1. No API key anywhere. The first-run wizard asked "Choose provider" of a
//      stdin nobody could type into and waited for ever (ssh without -t).
//   2. A data directory that cannot be written. The start died somewhere in
//      the middle with a stack trace from whichever module wrote first.
//
// Both must stop at once with a sentence that says what to change.
//
// A spawned process on purpose: index.js replaces process.stdin.isTTY with
// true for a piped stdin, so a check of the condition in isolation proves
// nothing about what the program does.

import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const HANG_MS = 20000;

function runFlint({ args = [], env = {}, dataDir }) {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "flint-refusal-"));
  const fakeHome = path.join(tmpBase, "fake-home");
  fs.mkdirSync(fakeHome, { recursive: true });

  const childEnv = {
    ...process.env,
    FLINT_DATA_DIR: dataDir ? dataDir(tmpBase) : path.join(tmpBase, "flint-data"),
    FLINT_TEST_PERMISSIONS_FILE: path.join(tmpBase, "permissions.json"),
    HOME: fakeHome,
    USERPROFILE: fakeHome,
    FLINT_OWN_ENV: "0",
    ...env,
  };
  for (const [k, v] of Object.entries(childEnv)) {
    if (v === undefined) delete childEnv[k];
  }

  return new Promise((resolve) => {
    // "pipe" and never written to: a stdin that is open, is not a terminal,
    // and never answers. That is what ssh without -t gives the process.
    const child = spawn(process.execPath, [path.join(repoRoot, "bin", "flint.js"), ...args], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: tmpBase,
      env: childEnv,
    });
    let stdout = "";
    let stderr = "";
    let hung = false;
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    const timer = setTimeout(() => { hung = true; child.kill("SIGKILL"); }, HANG_MS);
    child.on("close", (code) => {
      clearTimeout(timer);
      const leftovers = fs.readdirSync(fakeHome);
      // A killed child's sqlite handle outlives it by a moment on Windows.
      fs.rmSync(tmpBase, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      resolve({ code, stdout, stderr, hung, leftovers });
    });
  });
}

const NO_KEYS = {
  OPENROUTER_API_KEY: undefined,
  OPENAI_API_KEY: undefined,
  ANTHROPIC_API_KEY: undefined,
};

describe("start with nobody at the keyboard", () => {
  it("no API key and stdin is not a terminal: says so and exits, the wizard is not drawn", async () => {
    const r = await runFlint({ env: NO_KEYS });

    expect(r.hung, "the process waited on stdin until it was killed").toBe(false);
    expect(r.code).toBe(1);
    expect(r.stdout).not.toContain("Choose provider");
    expect(r.stdout).not.toContain("First Run");
    expect(r.stderr).toContain("No API key is configured");
    expect(r.stderr).toContain("OPENROUTER_API_KEY");
  });
});

describe("start with a data directory that cannot be written", () => {
  // A path below a regular file cannot be created on any platform, and unlike
  // a chmod it stays unwritable for root too.
  const belowAFile = (tmpBase) => {
    const blocker = path.join(tmpBase, "blocker");
    fs.writeFileSync(blocker, "x");
    return path.join(blocker, "data");
  };

  it("names the directory and the setting, exits 78, prints no stack", async () => {
    const r = await runFlint({
      args: ["--headless", "--task", "say hi"],
      env: { ...NO_KEYS, OPENROUTER_API_KEY: "test-key" },
      dataDir: belowAFile,
    });

    expect(r.hung).toBe(false);
    expect(r.code).toBe(78);
    expect(r.stderr).toContain("FLINT_DATA_DIR");
    expect(r.stderr).toContain(path.join("blocker", "data"));
    expect(r.stderr).not.toMatch(/^\s+at .+:\d+:\d+\)?$/m);
  });

  it("writes nowhere else instead", async () => {
    const r = await runFlint({
      args: ["--headless", "--task", "say hi"],
      env: { ...NO_KEYS, OPENROUTER_API_KEY: "test-key" },
      dataDir: belowAFile,
    });

    expect(r.leftovers).toEqual([]);
  });
});
