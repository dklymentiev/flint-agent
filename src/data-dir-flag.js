// First import of index.js (before stdio/guard.js and every module that
// computes a path at load): applies --data-dir to FLINT_DATA_DIR.
//
// Why a module of its own and not parseCLI(): ESM evaluates all static imports
// before any statement of index.js runs, so by the time parseCLI() set the env
// var, config.js (sessionsDir, permissionsFile) and the modules with a
// FLINT_DIR constant had already fixed their paths. A side-effect import that
// comes first is evaluated first, and it needs no change to those constants.
//
// The value is made absolute here, once: --cwd later chdirs, and a relative
// path would then point somewhere else.

import { resolve } from "node:path";

if (!process.env.FLINT_DATA_DIR) {
  const idx = process.argv.indexOf("--data-dir");
  if (idx !== -1 && process.argv[idx + 1]) process.env.FLINT_DATA_DIR = process.argv[idx + 1];
}
if (process.env.FLINT_DATA_DIR) process.env.FLINT_DATA_DIR = resolve(process.env.FLINT_DATA_DIR);
