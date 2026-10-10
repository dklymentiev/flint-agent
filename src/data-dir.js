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

import { mkdirSync, writeFileSync, unlinkSync } from "node:fs";
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

/** Create dir if needed and prove it takes a file. Throws what the OS says. */
function proveWritable(dir) {
  const probe = join(dir, `.write-probe-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(probe, "");
  unlinkSync(probe);
}

// Asked once: the install does not change owner while the process runs, and
// config.js calls installStateDir() several times at import.
let _installWritable = null;
export function installIsWritable() {
  if (_installWritable === null) {
    try { proveWritable(PROJECT_ROOT); _installWritable = true; }
    catch { _installWritable = false; }
  }
  return _installWritable;
}

/** True when this copy runs from inside a node_modules folder: an npm install. */
export function isPackageInstall(root = PROJECT_ROOT) {
  return root.split(/[\\/]/).includes("node_modules");
}

/**
 * Whether state may live next to the code.  Only in a checkout this user can
 * write.  Never inside an npm package: `npm install -g flint-agent@latest`
 * replaces the package folder, and everything Flint had written into it went
 * with it.  Measured on 1.14.6 -> 1.14.7 in a per-user npm prefix: 8 session
 * files before the update, 0 after, the saved permissions and the file memory
 * gone too.  So an update, the thing `/update` runs, deleted the user's work.
 */
export function stateBesideInstall() {
  return !isPackageInstall() && installIsWritable();
}

/**
 * The install-relative state directory.  Modules that master kept next to the
 * install (sessions/, .permissions.json, knowledge/) use this.  In order:
 *
 *   1. FLINT_DATA_DIR (--data-dir) when set.
 *   2. PROJECT_ROOT for a checkout this user can write (a git clone).
 *      Unchanged from before.
 *   3. ~/.flint otherwise: an npm install, whoever owns it (see
 *      stateBesideInstall), and any other copy this user cannot write
 *      (/opt/...).  On a root-owned one a plain `flint` died on
 *      "EACCES: mkdir <install>/sessions" and the only way to start at all
 *      was to know about FLINT_DATA_DIR.
 *
 * Step 3 is a rule about where such an install keeps its state, decided
 * before anything is written, not a second try after a write failed.  If
 * ~/.flint cannot be written either, stateDirRefusal() stops the start.
 *
 * The env var is re-read on every call, see homeStateDir().
 *
 * @returns {string} absolute path
 */
export function installStateDir() {
  const env = process.env.FLINT_DATA_DIR;
  if (env) return resolve(env);
  return defaultInstallStateDir();
}

/**
 * Steps 2 and 3 above, without the env var.  For the one caller that must not
 * follow FLINT_DATA_DIR: a child agent is started with FLINT_DATA_DIR pointing
 * at its own folder (~/.flint/children/<port>), while its sessions belong
 * with the parent's, in <state>/sessions/children, where the parent's log
 * collector looks for them.
 *
 * @returns {string} absolute path
 */
export function defaultInstallStateDir() {
  return stateBesideInstall() ? PROJECT_ROOT : join(homedir(), ".flint");
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

/**
 * What a start says when it has nowhere to write, or null when it has.
 *
 * Every module below these directories creates its own subdirectory on first
 * use, so an unwritable one used to surface wherever the first write happened:
 * as "[CRITICAL] Security init failed" from the audit log on one machine, as a
 * bare stack from the plugin loader on another. Asked once, up front, the
 * answer names the directory and the setting that moves it.
 *
 * There is deliberately no second place to try. Sessions and the audit trail
 * that quietly land somewhere the operator did not choose are worse than a
 * start that stops and says why.
 *
 * Proved by writing, not by access(): W_OK is not reliable on Windows, and a
 * directory that cannot be created has no mode bits to ask about.
 *
 * @param {string[]} dirs - directories Flint must be able to create and write
 * @returns {string|null}
 */
export function stateDirRefusal(dirs) {
  for (const dir of dirs) {
    try {
      proveWritable(dir);
    } catch (err) {
      return `[flint] Cannot write to ${dir} (${err.code || err.message}).\n` +
        "        Flint keeps its sessions, logs and audit trail there. Point it at a directory\n" +
        "        this user can write with --data-dir <dir> or FLINT_DATA_DIR, and start again.";
    }
  }
  return null;
}
