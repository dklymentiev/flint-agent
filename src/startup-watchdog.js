// Startup watchdog: if Flint has not finished starting within the timeout, it
// exits rather than hang. Time spent waiting for the operator is not startup.
//
// Owner, 2026-10-01, first run on a fresh machine: the first-run wizard and the
// "How careful should Flint be?" question were on screen, and the watchdog
// killed Flint at 30 s while it waited for an answer. The launcher's
// "loading..." spinner was also still repainting over both prompts, because the
// child only told it to stop once the main UI had drawn.

const TIMEOUT_MS = 30000;

let timer = null;
let done = false;

function arm() {
  if (done) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    process.stderr.write(`\n[WATCHDOG] Startup timeout (${TIMEOUT_MS / 1000}s) -- force exit\n`);
    process.exit(1);
  }, TIMEOUT_MS);
  timer.unref?.();
}

/** Start counting. Called once, at the top of index.js. */
export function startStartupWatchdog() {
  done = false;
  arm();
}

/** Startup finished: stop counting for good. */
export function clearStartupWatchdog() {
  done = true;
  if (timer) clearTimeout(timer);
  timer = null;
}

/** For tests: is the watchdog currently counting? */
export function isStartupWatchdogArmed() {
  return timer !== null;
}

/**
 * Run an interactive startup step: no countdown while the operator answers,
 * and the launcher spinner is told to stop before the question is drawn.
 * The countdown restarts in full once the step is over.
 */
export async function whileWaitingForOperator(fn) {
  if (timer) clearTimeout(timer);
  timer = null;
  // Same message the main UI sends when it has drawn; the launcher only
  // stops its spinner, so sending it early is harmless.
  try { process.send?.({ type: "flint:ready" }); } catch { /* no IPC channel */ }
  try {
    return await fn();
  } finally {
    arm();
  }
}
