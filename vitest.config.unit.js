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
// HOME/USERPROFILE: override os.homedir() so every module that computes
// join(homedir(), ".flint", ...) — api-auth, intent, providers, registry,
// tasks, log-collector, plugins, own-env, system, App — writes to the
// sandbox, not the real machine home.  Without this, tests that import
// those modules silently write api-token.json, intent-decisions.jsonl,
// provider.json, keys.enc, etc. into the user's real ~/.flint.
//
// Temp dirs live in the OS temp folder, NOT in the project tree.
//
// FLINT_TEST_PERMISSIONS_FILE: the one product file a test must not write where
// it normally lives. .permissions.json holds the developer's own saved
// permissions, onboarding answer and "[a]lways" approvals, and it is in
// .gitignore — so a suite that rewrote it left `git status` clean. Silent
// damage, found by a container check that diffed the work tree.
// Only the writable file is redirected; projectRoot keeps its real value, since
// profiles/memory/plugins are read from it and must stay the real ones.
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
  // FLINT_DATA_DIR is deliberately NOT set here.  home-guard.js (a setupFile)
  // isolates per-worker via HOME/USERPROFILE instead, so that homeStateDir()
  // falls through to os.homedir() and tests that mock homedir() are honored.
  // See home-guard.js for the full rationale.
  FLINT_OWN_ENV: "0",
  FLINT_TEST_MODE: "unit",
  FLINT_TEST_PERMISSIONS_FILE: SANDBOX_PERMS,
  HOME: SANDBOX_HOME,
  USERPROFILE: SANDBOX_HOME,
};

export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.js"],
    testTimeout: 10000,
    hookTimeout: 10000,
    env: TEST_ENV,
    setupFiles: ["tests/helpers/home-guard.js"],
  },
});
