import { defineConfig } from "vitest/config";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

// HOME/USERPROFILE: see vitest.config.unit.js for rationale.
// Temp dirs live in the OS temp folder, NOT in the project tree.
//
// FLINT_TEST_PERMISSIONS_FILE: the same isolation the other two configs have,
// and the reason it was missing here is worth recording. `npx vitest run
// <file>` uses THIS config, not vitest.config.unit.js, so fixing the two
// scripts covered `npm run test:unit` and `npm run test:integration` while
// leaving the most common way of running a single test — the one an
// engineer reaches for while iterating — writing straight into the checkout.
// Confirmed on this machine: a single-file run of permission-checks.test.js
// replaced the operator's .permissions.json with the five-tool allow map that
// the file's own beforeEach sets up. 43 tests passed while it happened.
// Every way of running a test has to be isolated, not the ones with a script.
const SANDBOX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "flint-test-home-"));
const SANDBOX_PERMS = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), "flint-test-perms-")),
  ".permissions.json",
);

export default defineConfig({
  test: {
    include: ["tests/**/*.test.js"],
    testTimeout: 10000,
    hookTimeout: 10000,
    // No venv in the developer's ~/.flint/env (see src/tools/own-env.js).
    env: {
      // Ink stops drawing intermediate frames when CI is set (is-in-ci), so the
      // console tests saw nothing on GitHub Actions (2026-10-02). Tests see the
      // console the way a terminal does.
      CI: "false",
      FLINT_OWN_ENV: "0",
      FLINT_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "flint-test-data-")),
      FLINT_TEST_PERMISSIONS_FILE: SANDBOX_PERMS,
      HOME: SANDBOX_HOME,
      USERPROFILE: SANDBOX_HOME,
    },
    setupFiles: ["tests/helpers/home-guard.js"],
  },
});
