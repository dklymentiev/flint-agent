// Central temp file/dir tracker: files and directories Flint creates during
// a run are registered here and cleaned up at process exit — including when
// the process is killed by SIGTERM/SIGINT (which simulates the step-budget
// ceiling or user abort).
//
// Usage: import { trackTempFile, trackTempDir } and pass every temp path
// Flint creates. The module installs one process-level signal handler that
// removes them all. This is process-wide cleanup, not per-turn.
//
// Why a central tracker rather than ad-hoc cleanup in each file:
//  - There are multiple creation sites (model-check, clipboard, agent .bat)
//    and each run can be cut short by SIGTERM before any local cleanup runs.
//  - A single list means no site has to remember to wire up its own
//    signal handler; the tracker is imported once at startup.
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import process from "node:process";

const trackedFiles = new Set();
const trackedDirs = new Set();

// Guard against re-entrant signal handling: once we've committed to shutting
// down, never run our signal handler again. cleanupTempFiles() clears the Sets
// so a re-entrant call is a no-op; this flag additionally ensures the
// re-emitted signal (see installHandlers) falls through to other listeners or
// the default disposition instead of re-entering our own handler.
let shuttingDown = false;

// Track which signals have handlers installed (for testability)
const registeredSignals = new Set();

let handlersInstalled = false;

function installHandlers() {
  if (handlersInstalled) return;
  handlersInstalled = true;

  // IMPORTANT: installing a SIGTERM/SIGINT listener in Node REMOVES the default
  // disposition of terminating the process on that signal. A listener that
  // only cleans up and returns -- without ensuring termination -- therefore
  // makes ANY process that tracked even one temp file hang forever on
  // SIGTERM/SIGINT. The handler below cleans up tracked files and then makes
  // sure the process DOES terminate, with the conventional 128+signum code.
  //
  // It must not clobber Flint's own signal handlers (gracefulShutdown in
  // src/index.js, the headless run's handler): Node calls ALL listeners of a
  // signal, once per delivery, so theirs run in the same delivery as ours and
  // they own the shutdown (kill child agents, save the session, exit). We
  // never race them by calling process.exit() here.
  //
  // If no other listener exists -- a process that only imported the tracker,
  // or model-check used as a library -- nobody else will end the process, so
  // we remove our listener and send the signal to ourselves again: it meets
  // the default disposition and terminates with 128+signum.
  //
  // The signal used to be re-sent in both cases. With another listener there,
  // that was a second delivery to it: the headless handler aborted and killed
  // the children twice, and gracefulShutdown was entered twice.
  //
  // Node delivers a signal to listeners with NO argument (the signal name is the
  // event name, not a parameter), so the name is captured per-handler via a
  // factory closure rather than read from the call argument or process.env
  // (both are wrong/fragile).
  const makeHandler = (sig) => {
    const handler = () => {
      if (shuttingDown) return;                       // never re-enter
      shuttingDown = true;

      registeredSignals.add(sig);
      cleanupTempFiles();                             // removes every tracked temp file/dir

      // Our listener goes either way. If it was the last one, re-send the
      // signal: process.kill queues delivery for the next tick, and with no
      // listener left it is Node's default action (terminate with
      // 128+signum). If others remain, this delivery has reached them too.
      process.removeListener(sig, handler);
      if (process.listenerCount(sig) === 0) process.kill(process.pid, sig);
    };
    return handler;
  };

  process.on("SIGTERM", makeHandler("SIGTERM"));
  process.on("SIGINT", makeHandler("SIGINT"));
  process.on("exit", cleanupTempFiles);
}

/** Register a temp file for cleanup on process exit / signal. */
export function trackTempFile(filePath) {
  if (!filePath) return;
  installHandlers();
  trackedFiles.add(filePath);
}

/** Register a temp directory for cleanup on process exit / signal. */
export function trackTempDir(dirPath) {
  if (!dirPath) return;
  installHandlers();
  trackedDirs.add(dirPath);
}

/** Remove all tracked temp files and directories. Safe to call manually. */
export function cleanupTempFiles() {
  for (const dir of trackedDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
  for (const file of trackedFiles) {
    try { rmSync(file, { recursive: true, force: true }); } catch {}
  }
  trackedDirs.clear();
  trackedFiles.clear();
}

/** Check if a signal handler has been registered (for testing). */
export function hasSignalHandler(sig) {
  return registeredSignals.has(sig);
}

/** The system temp dir Flint creates temp files in. */
export function getSysTmpDir() {
  return tmpdir();
}
