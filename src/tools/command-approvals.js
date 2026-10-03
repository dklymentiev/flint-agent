// [a]lways on a command prompt, remembered per project.
//
// Why this is its own file and not a field on the tool permission: the answer
// is not "this tool is fine", it is "this command is fine, in this project".
// Storing it as a tool-wide `allow` (which is what the permissions file did
// before) opens the tool everywhere — approving `npm test` in a scratch repo
// would then also approve it in the one holding production credentials, and the
// operator's answer was never about that.
//
// The key is a normalised (project, command) pair. Three separate narrowings,
// each of which has a way to be got wrong:
//
//   project  — the grant does not travel to another checkout
//   argv[0]  — the first word only, so `npm test` covers `npm test -- --watch`
//              and not `npm publish`. A grant is about what a command DOES.
//   argv[0] must be an actual executable — an absolute or relative path is
//              used as-is, because `./scripts/deploy.sh` is one program with a
//              specific meaning and flattening it to `deploy.sh` would match a
//              different file elsewhere on PATH.
//
// Persisted to .permissions.json under a reserved key, next to the other
// grants the operator has given, so there is one file to look at. A grant that
// lives in memory is a prompt again after a restart, which is what the owner hit
// on 2026-09-29 and read as "[a]lways did nothing".

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { config } from "../config.js";

// config.permissionsFile, for the reason in src/config.js: under a test run
// the writable copy must not be the developer's own. Defensive fallback for the
// tests that replace the config object with only the keys they read.
const FILE = config.permissionsFile
  || path.join(config.projectRoot || process.cwd(), ".permissions.json");
const KEY = "_commandApprovals";

let cache = null;

function load() {
  if (cache) return cache;
  cache = {};
  try {
    if (existsSync(FILE)) {
      const raw = JSON.parse(readFileSync(FILE, "utf8"));
      const saved = raw[KEY];
      if (saved && typeof saved === "object") cache = saved;
    }
  } catch {
    // An unreadable or corrupt file must not take the permission system down.
    // The failure mode is one extra prompt, which is the safe direction.
    cache = {};
  }
  return cache;
}

function persist() {
  try {
    const raw = existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf8")) : {};
    raw[KEY] = cache;
    writeFileSync(FILE, JSON.stringify(raw, null, 2) + "\n");
  } catch {}
}

/**
 * The project a command was approved in.
 *
 * One place decides what "the project" is, because the caller that writes a
 * grant and the caller that reads one have to agree exactly — when they do not,
 * an "[a]lways" silently becomes a prompt again, which is what the owner read
 * on 2026-09-29 as "[a]lways did nothing".
 *
 * An explicit cwd wins, since that is the agent stating where it is working.
 * Failing that, the session workdir, which is set once at boot and is the
 * project the operator is sitting in. Only then the process cwd.
 */
function projectOf(cwd) {
  const dir = cwd || process.env._FLINT_WORKDIR || process.cwd() || config.projectRoot;
  return path.normalize(path.resolve(dir));
}

/**
 * What the grant is about: the program being run, and its subcommand.
 *
 * The first two words, not the whole command line and not just the first word.
 * Both extremes are wrong and both were tried:
 *
 *   argv[0] only  — a grant for `npm test` then covered `npm publish`, which is
 *                   the opposite of what the operator agreed to. This is what
 *                   the first version of this file did, and the test that
 *                   caught it is the reason the subcommand is here.
 *   whole line    — approving `npm test` does not then cover `npm test -- --watch`,
 *                   so the operator answers the same question again over a flag.
 *
 * A leading path is the whole program: `./scripts/deploy.sh` is one specific
 * file, and taking its next word as a subcommand would key the grant on
 * whatever that script happens to be called.
 *
 * Known coarseness, stated rather than hidden: the second word is taken
 * literally, so a grant for `git -C` covers other `git -C` invocations, and one
 * for `npm` alone covers only bare `npm`. Both are over-grants in a narrow
 * corner, and the alternative — parsing every tool's flag grammar — is a worse
 * trade than a prompt that occasionally reappears.
 *
 * @returns {string|null} null for an empty command, which is "no grant applies"
 */
export function commandProgram(command) {
  if (!command || typeof command !== "string") return null;
  const trimmed = command.trim();
  if (!trimmed) return null;
  const m = trimmed.match(/^"([^"]+)"|^'([^']+)'|^(\S+)/);
  if (!m) return null;
  const program = m[1] || m[2] || m[3] || null;
  if (!program) return null;
  // A path is the whole program — see above.
  if (/[\\/]/.test(program)) return program;
  const sub = trimmed.slice(m[0].length).trim().match(/^(\S+)/);
  return sub ? `${program} ${sub[1]}` : program;
}

/** The key a grant is stored under. */
export function approvalKey({ cwd, command } = {}) {
  const program = commandProgram(command);
  if (!program) return null;
  return `${projectOf(cwd)}\u0000${program}`;
}

/**
 * Has this command already been approved in this project?
 *
 * Only the program is compared, which is why the grant is deliberately coarse:
 * the alternative is storing whole command lines, where approving one invocation
 * does not generalise and the operator answers the same question again on the
 * next flag change. The subcommand is kept on purpose — `npm test` and
 * `npm publish` are different decisions — while flags are not, because they
 * select behaviour within one decision and are the thing the operator does not
 * want to re-approve.
 */
export function getCommandApproval({ cwd, command } = {}) {
  const key = approvalKey({ cwd, command });
  if (!key) return false;
  return Boolean(load()[key]);
}

/**
 * Remember an approval for this command in this project.
 *
 * @returns {string|null} the key stored, or null if there was nothing to store
 */
export function grantCommandApproval({ cwd, command } = {}) {
  const key = approvalKey({ cwd, command });
  if (!key) return null;
  load()[key] = true;
  persist();
  return key;
}

/** Forget one approval. Used by /permissions and by tests. */
export function revokeCommandApproval({ cwd, command } = {}) {
  const key = approvalKey({ cwd, command });
  if (!key || !load()[key]) return false;
  delete cache[key];
  persist();
  return true;
}

/** Every grant, for display. */
export function listCommandApprovals() {
  return { ...load() };
}

/**
 * Drop the in-memory copy, so the next read comes from disk.
 *
 * Exported for tests, which need to prove an approval survived a restart. A
 * test that could not simulate a restart cannot check that it survived one, and
 * that is the property that was broken.
 */
export function _resetForTest() {
  cache = null;
}
