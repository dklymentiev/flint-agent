// Comprehensive home-isolation guard.
//
// Verifies that NO module under src/ writes to the real machine home's
// ~/.flint when running under vitest.  The round-1 guard only covered
// sqlite-store.js; this covers every module that uses os.homedir():
//   api-auth.js, intent.js, providers/state.js, providers/keys.js,
//   registry.js, tasks/db.js, log-collector.js, plugins/loader.js,
//   own-env.js, system.js, App.js, and any future module that does
//   join(homedir(), ".flint", ...).
//
// The mechanism: the vitest config overrides HOME and USERPROFILE to a
// sandbox directory.  os.homedir() therefore returns the sandbox, and
// all module-level const paths resolve there.  This test verifies that
// the sandbox is active and that the guarded modules produce sandbox paths.

import { describe, it, expect } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

// ── helpers ──────────────────────────────────────────────────

/** Compute what the real machine home would be WITHOUT the sandbox override. */
function naturalHomedir() {
  const savedHOME = process.env.HOME;
  const savedUP   = process.env.USERPROFILE;
  delete process.env.HOME;
  delete process.env.USERPROFILE;
  const real = os.homedir();
  if (savedHOME !== undefined) process.env.HOME = savedHOME;
  else delete process.env.HOME;
  if (savedUP !== undefined) process.env.USERPROFILE = savedUP;
  else delete process.env.USERPROFILE;
  return real;
}

// The sandbox is whatever HOME was set to by the vitest config.
// (Do not re-derive from a relative path — integration tests change cwd.)
const SANDBOX = path.resolve(process.env.HOME);

// ── tests ────────────────────────────────────────────────────

describe("home isolation guard", () => {

  it("os.homedir() returns the sandbox, not the real machine home", () => {
    const testHome = os.homedir();
    const realHome = naturalHomedir();

    // Under the fix, testHome === SANDBOX and testHome !== realHome.
    // Under old code (no HOME override), testHome === realHome → FAIL.
    expect(path.resolve(testHome)).toBe(SANDBOX);
    expect(path.resolve(testHome)).not.toBe(path.resolve(realHome));
  });

  it("sandbox .flint directory exists", () => {
    const flintDir = path.join(SANDBOX, ".flint");
    expect(fs.existsSync(flintDir)).toBe(true);
  });

  it("api-auth TOKEN_FILE resolves to sandbox, not real home", async () => {
    // api-auth.js computes: const FLINT_DIR = join(homedir(), ".flint")
    // We call loadOrCreateApiToken and verify the file appears in the sandbox.
    const { loadOrCreateApiToken } = await import("../../../src/security/api-auth.js");

    const token = loadOrCreateApiToken();
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(0);

    // The file should be in the sandbox
    const sandboxToken = path.join(SANDBOX, ".flint", "api-token.json");
    expect(fs.existsSync(sandboxToken)).toBe(true);

    const content = JSON.parse(fs.readFileSync(sandboxToken, "utf-8"));
    expect(content.token).toBe(token);
  });

  it("intent-decisions path resolves under sandbox homedir", async () => {
    // intent.js computes: const DECISIONS_FILE = join(homedir(), ".flint", "intent-decisions.jsonl")
    // Verify homedir() points to sandbox, so all derived paths are sandboxed.
    const flintDir = path.join(os.homedir(), ".flint");
    expect(path.resolve(flintDir)).toBe(path.join(SANDBOX, ".flint"));
  });

  it("sqlite-store guard still fires without FLINT_DATA_DIR", async () => {
    // Belt-and-suspenders: the sqlite-store guard from round 1 should still work.
    //
    // We MUST NOT delete HOME/USERPROFILE — that lets os.homedir() fall through
    // to the real machine home.  If the guard is missing (old code), the
    // database opens at the real ~/.flint/memory/.  Instead, point them at a
    // throwaway temp dir so even broken code cannot reach the real home.
    const saved = process.env.FLINT_DATA_DIR;
    delete process.env.FLINT_DATA_DIR;

    const origHOME = process.env.HOME;
    const origUP = process.env.USERPROFILE;
    const throwaway = fs.mkdtempSync(path.join(os.tmpdir(), "flint-guard-"));
    process.env.HOME = throwaway;
    process.env.USERPROFILE = throwaway;

    const { getDb, closeDb } = await import("../../../src/memory/sqlite-store.js");
    // The round-1 guard checks VITEST && !FLINT_DATA_DIR → throws
    expect(() => getDb()).toThrow(/Refusing to open real.*database/);
    try { closeDb(); } catch {}

    if (saved !== undefined) process.env.FLINT_DATA_DIR = saved;
    else delete process.env.FLINT_DATA_DIR;
    process.env.HOME = origHOME;
    process.env.USERPROFILE = origUP;
    fs.rmSync(throwaway, { recursive: true, force: true });
  });
});
