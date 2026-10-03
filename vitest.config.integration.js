import { defineConfig } from "vitest/config";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

// INTENT_MODEL is required by config.js and there is deliberately no fallback,
// so importing anything that pulls in config.js throws unless a value is set.
// That is right for the product and wrong for a test run: a clean clone has no
// .env, and the whole suite died at import with "INTENT_MODEL is required".
// The value is never called -- every test that touches the model mocks it.
// FLINT_OWN_ENV=0: no venv in the developer's ~/.flint/env (see own-env.js).
// HOME/USERPROFILE: see vitest.config.unit.js for rationale.
//
// Temp dirs live in the OS temp folder, NOT in the project tree.
//
// FLINT_TEST_PERMISSIONS_FILE: see vitest.config.unit.js. The permission file
// is the one thing a test must not write into the checkout, because it is
// gitignored and so the overwrite would leave no trace.
const SANDBOX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "flint-test-home-"));
const SANDBOX_PERMS = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), "flint-test-perms-")),
  ".permissions.json",
);
const TEST_ENV = {
  // Ink stops drawing intermediate frames when CI is set (is-in-ci), so the
  // console tests saw nothing on GitHub Actions (2026-10-02). Tests see the
  // console the way a terminal does.
  CI: "false",
  INTENT_MODEL: "test/intent-model",
  OPENROUTER_API_KEY: "test-key",
  FLINT_OWN_ENV: "0",
  FLINT_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "flint-test-data-")),
  FLINT_TEST_PERMISSIONS_FILE: SANDBOX_PERMS,
  HOME: SANDBOX_HOME,
  USERPROFILE: SANDBOX_HOME,
};

export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.js", "tests/functional/**/*.test.js", "tests/e2e/**/*.test.js"],
    testTimeout: 60000,
    hookTimeout: 30000,
    pool: "forks",
    env: TEST_ENV,
    // Its own empty cwd per test file; see the helper for why.
    setupFiles: ["tests/helpers/isolated-cwd.js", "tests/helpers/home-guard.js"],
  },
});
