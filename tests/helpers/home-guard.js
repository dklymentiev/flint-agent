// Home-guard: under vitest, os.homedir() MUST return the sandbox directory,
// not the real machine home.  Every module that computes
//   join(homedir(), ".flint", ...)
// at import time — api-auth.js, intent.js, providers/state.js, providers/keys.js,
// registry.js, tasks/db.js, log-collector.js, plugins/loader.js, own-env.js,
// system.js, App.js — will write there.  If the sandbox is not active, ALL of
// those leak into the real home.
//
// The vitest config sets HOME and USERPROFILE to the sandbox path.  This
// setupFile verifies that worked, and throws if it did not.
//
// FLINT_DATA_DIR is deliberately NOT set in the test environment. When it
// is set, homeStateDir() returns that path and bypasses os.homedir()
// entirely, which breaks every test that mocks os.homedir() or sets
// HOME/USERPROFILE to its own temp dir (agent-registry, api-pairing,
// headless-no-key-persist, mcp-user-config, mcp-secrets, test-runner-guard).
// By leaving FLINT_DATA_DIR unset, homeStateDir() falls through to
// os.homedir() (driven by HOME/USERPROFILE), which tests can intercept or
// override individually.  Per-worker isolation is provided by giving each
// worker its own HOME (see worker-home below), not by FLINT_DATA_DIR.
//
// The sqlite-store guard (src/memory/sqlite-store.js) checks that HOME is a
// sandbox temp dir, not the real machine home.

import os from "node:os";
import path from "node:path";
import { existsSync, mkdirSync } from "node:fs";

// One home directory per vitest worker. The config makes one HOME for the
// whole run, and the workers run test files in parallel, so the memory
// database (sqlite-store, skills, facts, patterns) was one file open in
// several processes at once: "SqliteError: disk I/O error" on the Windows CI
// runners, and rows one file inserted wiped by another file's cleanup
// (sqlite-store reflections failing in a full run, passing alone; 2026-10-02).
// A worker runs one file at a time, so its own home is enough.
if (process.env.VITEST === "true" && process.env.VITEST_POOL_ID) {
  const baseHome = path.resolve(process.env.HOME || os.homedir());
  const workerHome = path.join(baseHome + "-worker", `worker-${process.env.VITEST_POOL_ID}`);
  mkdirSync(workerHome, { recursive: true });
  process.env.HOME = workerHome;
  process.env.USERPROFILE = workerHome;
  // The same goes for the sandbox permissions file. The config names one file
  // for the whole run, so two test files in two workers wrote it at once:
  // an approval one file had just saved was gone when it read the file back
  // (permission-preserve and permission-checks, red in a full run, green
  // alone). One file per worker, as with the home.
  if (process.env.FLINT_TEST_PERMISSIONS_FILE) {
    process.env.FLINT_TEST_PERMISSIONS_FILE = path.join(workerHome, ".permissions.json");
  }
}

// FLINT_DATA_DIR must be unset for UNIT TESTS so homeStateDir() falls through
// to homedir(). Some setupFiles or earlier imports may have set it; clear it
// for unit tests only — integration tests spawn child processes that need
// FLINT_DATA_DIR inherited from the parent env (they use --data-dir CLI which
// cli.js parses into FLINT_DATA_DIR, but config.js is imported before parseCLI
// runs, so the child needs FLINT_DATA_DIR already set).
if (process.env.FLINT_TEST_MODE === "unit") {
  delete process.env.FLINT_DATA_DIR;
}

const home = os.homedir();
const EXPECTED_HOME = process.env.HOME;

if (process.env.VITEST === "true" && EXPECTED_HOME) {
  // The sandbox must be active.  If homedir() returns something else,
  // the vitest config is missing HOME/USERPROFILE overrides and every
  // module that uses homedir()/.flint will write to the real home.
  if (path.resolve(home) !== path.resolve(EXPECTED_HOME)) {
    throw new Error(
      `[HOME GUARD] os.homedir() is "${home}" — expected sandbox "${EXPECTED_HOME}". ` +
      `Tests must not read or write the real ~/.flint. ` +
      `Set HOME and USERPROFILE to the sandbox in your vitest config env.`
    );
  }

  // Ensure sandbox .flint dir exists (modules call mkdirSync but belt-and-suspenders)
  const flintDir = path.join(path.resolve(EXPECTED_HOME), ".flint");
  if (!existsSync(flintDir)) {
    mkdirSync(flintDir, { recursive: true });
  }
}
