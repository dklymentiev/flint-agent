// The first answer, and the clock on it.
//
// A call sent at 20:40:49 on 2026-09-29 never came back. The 10-minute timeout
// fired at 20:50:49, the call was retried, and for the whole ten minutes the
// console said `thinking #15 468s` — a number that is the age of the TASK, not
// of the call, so it looks equally alarming after ten seconds of normal work.
//
// Two separate faults, and the second is why this module exists:
//
//   1. The status line counted from the wrong clock (fixed in the UI layer).
//   2. Nothing gave up on the call. A provider that accepts the request and
//      never answers is the one failure where the only useful move is to drop
//      it and send it again, and Flint sat on it for the full 600s hard
//      timeout, twice, before it did.
//
// So: the watchdog is armed on the wait for the FIRST answer, not the whole
// call. 90 seconds of silence on a request that has been sent is a hung
// connection, not a slow model. The attempt is dropped (the request is aborted,
// not merely abandoned — the socket stays open otherwise), the operator is told
// which attempt it is, and after the last attempt the turn stops with the
// reason and how to continue.

/** Silence before a hung connection is dropped. Env override for tests. */
export function firstTokenTimeoutMs() {
  const v = parseInt(process.env.AGENT_FIRST_TOKEN_TIMEOUT_MS || "", 10);
  return Number.isFinite(v) && v > 0 ? v : 90_000;
}

/** How many hung calls in a row before the turn stops. */
export function maxStallAttempts() {
  const v = parseInt(process.env.AGENT_STALL_MAX_ATTEMPTS || "", 10);
  return Number.isFinite(v) && v > 0 ? v : 3;
}

/**
 * What the operator sees when one attempt is dropped.
 *
 * The attempt number is the whole point: "retrying" alone, once, looks like the
 * loop hung.
 *
 * @param {number} seconds — silence before the drop
 * @param {number} attempt  — 1-based
 * @param {number} max      — total attempts allowed
 * @returns {string}
 */
export function stallNote(seconds, attempt, max) {
  return `no answer for ${Math.round(seconds)}s, retrying, ${attempt} of ${max}`;
}

/**
 * The line the turn ends on after the last hung call.
 *
 * @param {number} attempts
 * @param {number} timeoutMs
 * @returns {string}
 */
export function stallStopNote(attempts, timeoutMs) {
  const secs = Math.round((timeoutMs || 0) / 1000);
  return `Stopped: the provider sent no answer for ${secs}s on ${attempts} attempt${attempts === 1 ? "" : "s"} in a row, ` +
    `and Flint dropped each one. Nothing ran, and the work may be unfinished. ` +
    `To continue, type: continue. If it keeps happening, switch the model with /model or the provider with /provider.`;
}

/**
 * Run one model call under a watchdog on the FIRST answer.
 *
 * `run` receives `(onToken, signal)`. The signal aborts the in-flight request
 * when the watchdog fires, because an abandoned promise still holds an open
 * socket: on 2026-09-29 two of those were still open when the retry started.
 *
 * @param {(onToken: Function, signal: AbortSignal) => Promise<any>} run
 * @param {object} opts - { timeoutMs, signal, onToken, onFirstToken, onStall }
 * @returns {Promise<any>} the call's result
 * @throws {Error} with `.isStall` set when the watchdog fired
 */
export async function callWithStallWatchdog(run, { timeoutMs, signal, onToken, onFirstToken, onStall } = {}) {
  const controller = new AbortController();
  let timer = null;
  let watched = false;

  const onExternalAbort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener("abort", onExternalAbort, { once: true });
  }

  // Armed until the first token or the answer itself. Once the model starts
  // writing, there is no silence left to measure.
  const disarm = () => {
    watched = false;
    if (timer) { clearTimeout(timer); timer = null; }
  };

  const forwardToken = (token) => {
    if (watched) {
      // The model has started writing: there is no silence left to measure.
      // Told here rather than on the way out, because a call that streams for
      // a minute and then fails should still have reported that it started.
      disarm();
      onFirstToken?.();
    }
    onToken?.(token);
  };

  let rejectStall = null;
  const stalled = new Promise((_, reject) => { rejectStall = reject; });

  const call = (async () => run(forwardToken, controller.signal))();
  // The race decides; if the watchdog wins, the call's own later rejection is
  // nobody's problem and must not become an unhandled rejection.
  call.catch(() => {});

  if (timeoutMs > 0) {
    watched = true;
    timer = setTimeout(() => {
      const err = new Error(`no answer for ${timeoutMs}ms`);
      err.isStall = true;
      onStall?.(err);
      controller.abort(err);
      rejectStall(err);
    }, timeoutMs);
    // Never hold the process open for a watchdog on a call that already ended.
    timer.unref?.();
  }

  try {
    const out = await Promise.race([call, stalled]);
    // A non-streaming call (stream: false) never fires onToken, so the
    // watchdog is still armed here. Disarm it and report the first answer.
    if (watched) {
      disarm();
      onFirstToken?.();
    }
    return out;
  } finally {
    disarm();
    if (signal) signal.removeEventListener?.("abort", onExternalAbort);
  }
}