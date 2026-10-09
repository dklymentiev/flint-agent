// The --headless run, as functions a test can call.
//
// Same reason as headless-start.js: index.js starts a session when it is
// imported, so anything written inline there can only be tested by a copy of
// itself. What a headless run reports lives here.

import { execSync } from "node:child_process";

/**
 * The session's running totals, as one object. Taken once before the task
 * starts and once when the record is written; the record is the difference.
 *
 * @param {object} state - store.getState()
 */
export function runTotals(state) {
  return {
    cost: state.sessionCost || 0,
    prompt: state.sessionPromptTokens || 0,
    completion: state.sessionCompletionTokens || 0,
    cached: state.sessionCachedTokens || 0,
    toolCalls: state.totalToolCalls || 0,
    deniedCalls: state.deniedCalls || 0,
  };
}

/**
 * `git status --porcelain` of one folder, as lines. Never throws: a folder
 * that is not a repository, or a git that is missing, is an empty list, so
 * the record is still written.
 *
 * The folder is named by the caller. With no cwd this used to read the
 * process's own directory, and the launcher runs Flint's process from the
 * install folder (launcher.js), so a run started without --cwd listed the
 * changes of the Flint checkout instead of the folder the agent worked in.
 *
 * @param {string} dir
 * @returns {string[]}
 */
export function modifiedFilesIn(dir) {
  const changes = gitChangesIn(dir);
  return changes ? changes.split("\n").map((l) => l.trim()) : [];
}

/**
 * The same `git status --porcelain`, as text: "" for a clean repository and
 * null when git could not answer (not a repository, no git). Auto-verify needs
 * the difference: "nothing changed" is a reason to ask the model again,
 * "cannot tell" is not.
 *
 * `git status`, not `git diff --stat`: a new untracked file is a change.
 *
 * @param {string} dir
 * @returns {string|null}
 */
export function gitChangesIn(dir) {
  try {
    return execSync("git status --porcelain", {
      encoding: "utf-8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"],
      ...(dir ? { cwd: dir } : {}),
    }).trim();
  } catch {
    return null;
  }
}

/**
 * The JSON a headless caller reads (docs/headless-mode.md).
 *
 * Every number is the run's: the session totals now, minus what they were when
 * the task started (`baseline`). One basis for all of them. Before this, cost
 * and tokens came from the last processMessage's own figures and the tool
 * counts from the session, so when auto-verify sent a second message the
 * first turn's spend dropped out of a record whose tool counts still had it.
 *
 * @param {object} o
 * @param {"done"|"time"|"killed"} o.stopReason
 * @param {object|null} o.result - the last processMessage return value, if any
 * @param {object} o.state - store.getState()
 * @param {object} o.baseline - runTotals() from before the task
 * @param {number} o.durationMs
 * @param {string} o.model
 * @param {string[]} o.modifiedFiles
 */
export function buildHeadlessResult({ stopReason, result, state, baseline, durationMs, model, modifiedFiles }) {
  const now = runTotals(state);
  const hasResult = !!result && typeof result === "object";
  const prompt = now.prompt - baseline.prompt;
  const completion = now.completion - baseline.completion;
  return {
    response: hasResult ? (result.text || "") : (state.lastSummary || ""),
    cost: Math.max(0, now.cost - baseline.cost),
    tokens: prompt + completion,
    repoClaimGap: (hasResult && result.repoClaimGap) || false,
    model: state.model || model,
    stop_reason: stopReason,
    duration_ms: durationMs,
    tool_calls: now.toolCalls - baseline.toolCalls,
    denied_calls: now.deniedCalls - baseline.deniedCalls,
    modified_files: modifiedFiles,
    tokens_obj: {
      prompt,
      completion,
      cached: now.cached - baseline.cached,
    },
  };
}

// Tools that change files. Auto-verify only asks again after one of these: an
// answer in words with no diff is normal, an edit with no diff is a failure.
const FILE_MUTATING_TOOLS = new Set([
  "write_file", "edit_file", "create_directory", "delete_file",
  "copy_file", "move_file",
]);

export const VERIFY_MESSAGE =
  "Your previous edit produced NO changes (git diff is empty). " +
  "edit_file likely failed due to wrong old_text. " +
  "Re-read the file, find the exact text, and try again.";

/**
 * Exit codes of a headless run, one rule (docs/headless-mode.md):
 * 0 the task ran to its own end, 1 an error, 2 the run was stopped before its
 * end and a record was still written. Whatever stopped it: "killed" used to
 * exit 0 while "time" exited 2, so a CI step that was killed half way passed.
 */
export const EXIT_DONE = 0;
export const EXIT_ERROR = 1;
export const EXIT_STOPPED = 2;

/**
 * How long a turn gets to unwind after a stop was asked for. An abort reaches
 * a model call and a command at once; this is for whatever does not listen.
 */
export const STOP_GRACE_MS = 5000;

const STOPPED = Symbol("headless-run-stopped");

/**
 * The headless task loop: the task, the auto-verify retry, and the ways the
 * run can be stopped from outside.
 *
 * A stop (requestStop) is a state of the run, not an event aimed at whatever
 * happens to be in flight. The time limit used to be a timer that aborted
 * app.abortController if one existed at that instant. processMessage only
 * holds a controller while the agent loop runs, so a limit that passed while
 * the turn was saving the session, or between the first turn and the
 * auto-verify one, set a flag and aborted nothing: the turn returned normally,
 * the run printed "done" and exited 0, and a second turn started with no limit
 * left to stop it. Now:
 *
 *  - every turn is given the run's own abort signal, so a stop reaches a turn
 *    that starts after it as well as one in flight;
 *  - no turn starts once a stop was asked for;
 *  - the reason is checked after every turn, however the turn ended;
 *  - a turn that does not unwind within `graceMs` is left behind: the record
 *    is written and the process exits;
 *  - the commands the run started are killed, and waited for, before the
 *    record is written.
 *
 * @param {object} d
 * @param {{abortController: AbortController|null, shuttingDown: boolean, timeLimitHit: boolean}} d.app
 * @param {(content: string, name: null, opts: {signal: AbortSignal}) => Promise<object>} d.processMessage
 * @param {() => Promise<void>} d.saveSession
 * @param {(stopReason: string, result: object|null) => object} d.buildResult
 * @param {() => string|null} d.gitChanges - see gitChangesIn
 * @param {(text: string, flushed: () => void) => void} d.write - stdout
 * @param {(code: number) => void} d.exit
 * @param {(line: string) => void} d.logError - stderr
 * @param {() => void} d.killChildren - kills the run's commands before returning
 * @param {number} [d.graceMs]
 */
export function createHeadlessRun({ app, processMessage, saveSession, buildResult, gitChanges, write, exit, logError, killChildren, graceMs = STOP_GRACE_MS }) {
  let stopReason = null;
  const runAbort = new AbortController();
  let announceStop;
  const stopAsked = new Promise((resolve) => { announceStop = resolve; });

  /** Ask the run to end. The first reason is the one reported. */
  function requestStop(reason) {
    if (stopReason) return;
    stopReason = reason;
    if (reason === "time") app.timeLimitHit = true;
    const why = new Error(reason === "time" ? "time-limit-exceeded" : "headless-run-" + reason);
    runAbort.abort(why);
    // The turn in flight forwards runAbort to its own controller; this is for
    // a controller made by anything that did not get the signal.
    try { app.abortController?.abort(why); } catch {}
    announceStop();
  }

  async function turn(content) {
    if (stopReason) throw STOPPED;
    const work = processMessage(content, null, { signal: runAbort.signal });
    // Whoever loses the race must not become an unhandled rejection.
    work.catch(() => {});
    const giveUp = stopAsked.then(() => new Promise((_, reject) => setTimeout(() => reject(STOPPED), graceMs)));
    giveUp.catch(() => {});
    return Promise.race([work, giveUp]);
  }

  function finish(code, output) {
    if (!output) return exit(code);
    // Exit from the flush callback: on a pipe, process.exit() right after
    // write() can drop the record. The timer is for a pipe that never drains.
    write(JSON.stringify(output) + "\n", () => exit(code));
    setTimeout(() => exit(code), 5000);
  }

  /**
   * @param {{ task: string, timeLimitSec?: number|null }} o
   */
  async function run({ task, timeLimitSec }) {
    const timer = timeLimitSec && timeLimitSec > 0
      ? setTimeout(() => requestStop("time"), timeLimitSec * 1000)
      : null;
    let result = null;
    let failure = null;
    try {
      result = await turn(task);
      // The edit silently failed (wrong old_text, usually): one more turn.
      const edited = (result.toolCalls || []).some((tc) => FILE_MUTATING_TOOLS.has(tc.name));
      if (!stopReason && edited && result.text && !result.text.includes("Budget limit") && gitChanges() === "") {
        result = await turn(VERIFY_MESSAGE);
      }
    } catch (err) {
      failure = err;
    }
    if (timer) clearTimeout(timer);

    if (stopReason) {
      killChildrenOnce();
      try { await saveSession(); } catch (err) { logError("[headless] Session not saved: " + err.message + "\n"); }
      return finish(EXIT_STOPPED, buildResult(stopReason, result));
    }
    if (failure) {
      logError("[headless] Error: " + (failure?.message || String(failure)) + "\n");
      return finish(EXIT_ERROR, null);
    }
    const output = buildResult("done", result);
    output.truncated_at = result.truncated_at || null;
    return finish(EXIT_DONE, output);
  }

  let childrenKilled = false;
  function killChildrenOnce() {
    if (childrenKilled) return;
    childrenKilled = true;
    try { killChildren(); } catch {}
  }

  /**
   * What SIGTERM and SIGINT do. Safe to call at any moment of the run and any
   * number of times: before the first turn (the run then ends without
   * starting one), during a turn, after the record.
   *
   * app.shuttingDown is set for the rest of Flint, which reads it; the run
   * itself goes by its own stop reason.
   */
  function onSignal() {
    app.shuttingDown = true;
    requestStop("killed");
    killChildrenOnce();
  }

  return { run, requestStop, onSignal, stopReason: () => stopReason };
}

/**
 * Point SIGTERM and SIGINT at a headless run.
 *
 * Called before bootstrap(), so a signal during startup is not lost: the
 * handler used to abort the controller of the turn in flight and nothing
 * else, and a listener on a signal takes away Node's default of dying on it.
 * A SIGTERM that arrived before the first turn therefore did nothing at all,
 * and the task then ran in full.
 *
 * @param {{ on: (signal: string, fn: () => void) => unknown }} proc - process
 * @param {{ onSignal: () => void }} run - from createHeadlessRun
 */
export function installHeadlessSignals(proc, run) {
  for (const signal of ["SIGTERM", "SIGINT"]) proc.on(signal, () => run.onSignal());
}
