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

import os from "node:os";
import path from "node:path";
import { existsSync, mkdirSync } from "node:fs";

// The expected sandbox is whatever HOME was set to by the vitest config.
// We do NOT re-derive it from a relative path, because integration tests
// change cwd (isolated-cwd.js) which would make path.resolve() diverge.
const EXPECTED_HOME = process.env.HOME;

const home = os.homedir();

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
