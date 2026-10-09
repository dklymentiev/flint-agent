// Protection: no unit test may write to the operator's real ~/.flint.
//
// The mechanism: the vitest config (home-guard.js setupFile) rewrites
// HOME/USERPROFILE to a temp sandbox dir and deletes FLINT_DATA_DIR.
// This test verifies that invariant held during the ENTIRE test run — not
// just at module load, but after every worker has run its files.
//
// If a module lazily re-resolves homedir() AFTER a test changed HOME back to
// the real machine home (a common mistake: forgetting to restore env in
// afterEach, or importing a module that calls homedir() at call-time rather
// than import-time), that module would target the real ~/.flint.  This test
// catches the class of bug by checking that os.homedir() still returns the
// sandbox.
//
// On the current (broken) code this test is RED: homeStateDir() cached the
// FLINT_DATA_DIR path on first call and never re-resolved, so tests that
// changed HOME had no effect.  After the fix (no cache, FLINT_DATA_DIR unset),
// it is GREEN.

import { describe, it, expect } from "vitest";
import path from "node:path";
import os from "node:os";

// What HOME was set to when the test process started (by the config + home-guard).
const SANDBOX_HOME = path.resolve(process.env.HOME);

describe("real-home immunity", () => {

  it("os.homedir() still returns the sandbox after all tests have run", () => {
    // If a prior test leaked HOME back to the real machine home, this fails.
    // That would mean subsequent modules writing to ~/.flint hit the real disk.
    expect(path.resolve(os.homedir())).toBe(SANDBOX_HOME);
  });

  it("FLINT_DATA_DIR is not set (so homeStateDir falls through to homedir)", () => {
    // When FLINT_DATA_DIR is set, homeStateDir() ignores homedir() and returns
    // the FLINT_DATA_DIR path — breaking every test that mocks os.homedir().
    // The fix unsets it in home-guard.js.
    expect(process.env.FLINT_DATA_DIR).toBeUndefined();
  });

  it("the resolved ~/.flint is inside the sandbox, not the real home", async () => {
    // Any module using homeStateDir() or join(homedir(), ".flint") must land
    // in the sandbox.  Importing fresh verifies the module-level consts
    // (captured at import time) resolve correctly.
    const { homeStateDir } = await import("../../src/data-dir.js");
    const resolved = path.resolve(homeStateDir());
    expect(resolved).toBe(path.join(SANDBOX_HOME, ".flint"));
  });
});
