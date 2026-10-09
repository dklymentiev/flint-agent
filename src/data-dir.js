// Centralized resolution of Flint's writable state directories.
//
// Before --data-dir / FLINT_DATA_DIR existed, Flint kept two distinct classes
// of writable state in two different places:
//
//   1. "home state" — everything that belongs to the operator's identity and
//      must survive across machines/installs: keys, provider.json, api-token,
//      pairings, spend, intent-decisions, memory (sqlite + skills + MEMORY.md),
//      agent-prompt-snapshots, model-curated, etc.  These lived in ~/.flint/.
//
//   2. "install state" — per-session / per-install scratch that is meaningful
//      only relative to this checkout: sessions/, .permissions.json,
//      knowledge/, and the children-sessions dir.  These lived next to the
//      install root (PROJECT_ROOT).
//
// A single dataDir() with a default of ~/.flint cannot express this split:
// it would pull sessions/ and .permissions.json out of the install dir into
// the home dir, breaking the "without FLINT_DATA_DIR, behaviour is unchanged"
// invariant.  So we expose two resolvers.  When FLINT_DATA_DIR is set, both
// resolve to the same custom directory — the setting still redirects every
// write off the read-only install.

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The install root (parent of src/).  config.js computes its own, but this
// module must be import-safe (no config import, to avoid cycles), so we
// resolve relative to this file's location.
const __dirname = resolve(fileURLToPath(import.meta.url), "..");
const PROJECT_ROOT = resolve(join(__dirname, ".."));

/**
 * The operator's home state directory: ~/.flint by default, or the value of
 * FLINT_DATA_DIR (--data-dir) when set.  Modules that master kept in ~/.flint
 * (keys, provider.json, memory sqlite, intent-decisions, etc.) use this.
 *
 * Re-resolved on every call: a stale cache would freeze the first value of
 * FLINT_DATA_DIR (or the first mocked homedir()) for the lifetime of the
 * process, defeating test isolation that changes env vars after import.
 *
 * @returns {string} absolute path
 */
export function homeStateDir() {
  const env = process.env.FLINT_DATA_DIR;
  if (env) return resolve(env);
  return join(homedir(), ".flint");
}

/**
 * The install-relative state directory: PROJECT_ROOT by default, or the value
 * of FLINT_DATA_DIR (--data-dir) when set.  Modules that master kept next to
 * the install (sessions/, .permissions.json, knowledge/) use this.
 *
 * Re-resolved on every call, see homeStateDir().
 *
 * @returns {string} absolute path
 */
export function installStateDir() {
  const env = process.env.FLINT_DATA_DIR;
  if (env) return resolve(env);
  return PROJECT_ROOT;
}

/**
 * Backward-compatible single entry point.
 *
 * Returns homeStateDir().  This is the historical default for the *majority*
 * of paths; call sites that need the install-relative root should use
 * installStateDir() directly.  Kept so that a search for dataDir() finds the
 * intent.
 *
 * @deprecated prefer homeStateDir() or installStateDir()
 */
export function dataDir() {
  return homeStateDir();
}

/** Force a specific data dir — used by tests that need to point at a temp dir
 *  without going through env vars (e.g. before modules have loaded).
 *  Sets FLINT_DATA_DIR so every subsequent call to homeStateDir() /
 *  installStateDir() picks up the new value. */
export function setDataDir(dir) {
  if (dir) process.env.FLINT_DATA_DIR = resolve(dir);
  else delete process.env.FLINT_DATA_DIR;
}
