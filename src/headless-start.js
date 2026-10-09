// The --headless startup, as a function.
//
// Why it is not inline in index.js: a test can only prove behaviour it can
// actually run. index.js is a module with side effects — importing it starts a
// session — so a test that restates the headless block checks its own copy of
// it and stays green after the real block is broken. The defect this came
// from: a headless run held a confirmation prompt for 600 s, twice,
// because the unattended flag was never set here.
//
// index.js calls this once, on `cli.action === "headless"`.

import { bulkSetPermission, setUnattended } from "./tools/permissions.js";
import { config } from "./config.js";

/**
 * Mark the run as unattended as early as the CLI is known.
 *
 * Called from index.js right after parseCLI(), before the first-run wizard and
 * before bootstrap() — both of which can ask a question. Setting this further
 * down, in the headless block, was too late: the wizard had already run and
 * initOnboarding() inside bootstrap() had already drawn the menu.
 *
 * Idempotent, and a no-op for every other action.
 *
 * @param {{ action?: string }} cli
 * @returns {boolean} true when this is a headless run
 */
export function markHeadless(cli) {
  if (cli?.action !== "headless" && cli?.action !== "check") return false;
  config.headless = true;
  return true;
}

/**
 * Move the process into the directory --cwd names, before anything reads it.
 *
 * Split from startHeadless() because of WHEN, not what. bootstrap() builds the
 * system message (bootstrap.js:480 -> system-prompt.js:252 prints
 * process.cwd()) and seeds the session with it (bootstrap.js:410/417). Under
 * the generic profile's contextMode "full" that object is messages[0], which
 * buildContext passes straight through (message-handler.js:86 returns null), so
 * it is what the model receives on its first request — and runTurn's per-turn
 * rebuild cannot undo it afterwards. The chdir used to happen in the headless
 * block at index.js:~966, i.e. after bootstrap(), which is why a run launched
 * from the install directory told the model to work there and it spent its
 * first calls hunting for the repository.
 *
 * @param {{ cwd?: string, stderr?: NodeJS.WritableStream }} opts
 * @returns {string|null} the directory Flint now runs in, or null when none given
 */
export function enterCwd({ cwd, stderr = process.stderr } = {}) {
  if (!cwd) return null;

  try {
    process.chdir(cwd);
  } catch (e) {
    stderr.write("[headless] Cannot chdir to " + cwd + ": " + e.message + "\n");
    // A bad --cwd is fatal, not a warning: mirrors index.js.
    process.exit(1);
  }

  // Set projectRoot so shell commands (run_command) and path resolution run
  // in the --cwd directory.
  config.projectRoot = cwd;
  config.baseDir = cwd;

  // Route filesystem WRITE tools to the --cwd directory (the task repository).
  // Without this, write_file / edit_file resolve relative paths against
  // config.workdir (set by initWorkspace to the per-session workspace), and
  // the edits the agent is supposed to make in --cwd are lost in the session
  // workspace folder — which breaks headless workflows like SWE-bench that
  // need the agent to edit an external checkout. See filesystem.js:resolveWritePath.
  //
  // enterCwd is called twice: first from prepareHeadless() (before bootstrap →
  // initWorkspace overwrites config.workdir with the session workspace),
  // and again from startHeadless() AFTER bootstrap finishes. The second call
  // is the one that sticks — initWorkspace's session-workspace value is
  // replaced by cwd, so relative writes land in --cwd.
  config.workdir = cwd;

  return cwd;
}

/**
 * Everything a headless run needs settled before the first question-shaped or
 * cwd-reading step: the flag, then the directory. One call, so the two cannot
 * be split or reordered by a caller.
 *
 * A no-op for every other action, and that is deliberate. The stdio mode also
 * carries a `cwd` on its cli object, and its own guard (stdio/guard.js) has
 * already entered it; running enterCwd() for it would repoint
 * config.projectRoot at the agent's folder, and with it everything that
 * resolves from projectRoot at call time (bus plugins, the log collector's
 * children directory). The first version of this fix did exactly that.
 *
 * Idempotent: index.js calls it right after parseCLI(), because the first-run
 * wizard runs before bootstrap(), and bootstrap() calls it again as its first
 * step, so the order "directory first, system message after" holds inside the
 * function a test can run and does not depend on index.js getting it right.
 *
 * @param {{ action?: string, cwd?: string }} cli
 * @param {{ stderr?: NodeJS.WritableStream }} [opts]
 * @returns {string|null} the directory entered, or null
 */
export function prepareHeadless(cli, { stderr = process.stderr } = {}) {
  if (!markHeadless(cli)) return null;
  return enterCwd({ cwd: cli.cwd, stderr });
}

/**
 * What a headless run says instead of opening the first-run key wizard.
 *
 * The wizard (cli.js runFirstRunSetup) reads the provider and the key from
 * stdin. With nobody there it is one more way to wait for a human, so a
 * headless run with no key configured stops with a sentence that says what is
 * missing. Returns null when there is nothing to refuse.
 *
 * @param {{ action?: string }} cli
 * @param {boolean} needsSetup - config.needsFirstRunSetup
 * @returns {string|null}
 */
export function headlessSetupRefusal(cli, needsSetup) {
  if (cli?.action !== "headless" || !needsSetup) return null;
  return "[headless] No API key is configured and nobody is here to enter one. " +
    "Pass the provider's key in the environment (for example OPENROUTER_API_KEY) and start again.";
}

/**
 * Prepare permissions and the working directory for an unattended run.
 *
 * @param {{ cwd?: string, stderr?: NodeJS.WritableStream }} opts
 * @returns {string|null} the directory Flint runs in, or null when none given
 */
export function startHeadless({ cwd, stderr = process.stderr } = {}) {
  config.headless = true;

  // Auto-approve tools in headless mode.
  bulkSetPermission("allow");

  // No operator, no answers. This is the line that was missing: without it the
  // run is not unattended, and anything the command guard still forces through
  // falls to confirmFn and races a 600 s timer — exactly the DENIED_TIMEOUT in
  // security.log of the run that showed the defect. The unattended flag makes
  // permissions.js deny at once and tell the model why.
  setUnattended(true);

  return enterCwd({ cwd, stderr });
}