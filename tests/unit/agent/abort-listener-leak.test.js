// One AbortSignal listener per model call, for the life of the process.
//
// Backlog item 17 ("out of memory in minutes"), and it is the mechanism item 16
// names ("abort listeners pile up on a signal") points at.
//
// anySignalAborted merges the whole-loop signal (the API's /stop, /new) with the
// per-step signal (Esc). Every model call builds one, attaching a listener to
// each input signal. It returned only the merged signal, so the only code that
// could remove those listeners was the abort handler itself — which fires when
// the signal aborts, and does not fire when a model call simply finishes. So a
// long turn attached one listener to the long-lived loop signal per model call
// and removed none of them.
//
// Measured, before the fix: 20,000 model calls left 20,000 abort listeners on
// one signal and 57 MB of retained heap — unbounded, but slow. Node prints
// MaxListenersExceededWarning past 10, which is the symptom in item 16.
//
// This test is deliberately written as a growth measurement rather than a
// listener count. A listener count is the symptom; the backlog asks for a heap
// measurement, and a test that only counts listeners would still pass if
// something else retained the memory.

import { describe, it, expect, vi } from "vitest";

vi.mock("../../../src/logging/logger.js", () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}));

// 2,000 calls: enough that the pre-fix leak leaves 2,000 listeners on one
// signal and misses the assertion by a wide margin, and cheap enough that this
// file stays fast next to the rest of the suite.
//
// Deliberately no --expose-gc in the shared unit config. Adding execArgv there
// made one full run on 2026-09-30 push this file to 72 s and time out a dozen
// unrelated tests — the same failure happening again, caused by the
// measurement itself. The heap assertion below is therefore a wide guard, and
// the listener count is what actually makes this test red.
const CALLS = 2000;

/** Heap in MB. No forced GC: see the note on CALLS. */
function heapMB() {
  return process.memoryUsage().heapUsed / (1024 * 1024);
}

describe("anySignalAborted: listeners do not outlive the model call", () => {
  it("leaves the loop signal flat over many finished calls", async () => {
    const { anySignalAborted } = await import("../../../src/agent/agent.js");
    const { getEventListeners } = await import("node:events");

    // One long-lived loop signal, as runAgent's `signal` is for a whole turn.
    const loop = new AbortController().signal;

    // Each call = one finished model call: a fresh step signal, merged, and
    // then released because the call is over.
    //
    // `merged?.dispose?.()` and not `merged.dispose()`: against the pre-fix
    // helper, which returned a bare signal with no dispose, the strict call
    // threw TypeError on the first iteration and the test failed for that
    // reason instead of measuring the leak it exists to measure.
    const runCalls = (n) => {
      for (let i = 0; i < n; i++) {
        const step = new AbortController();
        const merged = anySignalAborted(loop, step.signal);
        merged?.dispose?.();
      }
    };

    // Warm up, so the measurement is not dominated by first-call allocation.
    runCalls(1000);
    const before = heapMB();
    runCalls(CALLS);
    const after = heapMB();

    // The leak this replaces left one listener per call on `loop`. After the
    // fix every call disposes, so nothing should remain attached.
    expect(
      getEventListeners(loop, "abort").length,
      "abort listeners are still piling up on the long-lived signal",
    ).toBe(0);

    // Measured, not guessed, and the numbers are why this is worded carefully.
    // The pre-fix leak retains roughly 4 MB per 2,000 calls (10 MB per 5,000;
    // 57 MB per 20,000), so this ceiling does NOT catch it and is not meant
    // to. Without a forced collection this figure also includes garbage, so a
    // tight bound would be a coin flip.
    //
    // The assertion that actually bites is the listener count above: 2,000
    // retained listeners versus 0. This one guards against some future leak
    // that is far heavier per object. Said plainly, because a reader would
    // otherwise assume the heap number is what makes this test red, and it is
    // not.
    expect(
      after - before,
      `heap grew ${(after - before).toFixed(1)} MB over ${CALLS} model calls — something bigger is being retained`,
    ).toBeLessThan(32);
  }, 60000);

  it("still aborts when a signal aborts — disposing must not disarm it", async () => {
    const { anySignalAborted } = await import("../../../src/agent/agent.js");

    const loop = new AbortController();
    const step = new AbortController();
    const { signal, dispose } = anySignalAborted(loop.signal, step.signal);

    expect(signal.aborted).toBe(false);
    loop.abort(new Error("stop the whole loop"));
    expect(signal.aborted, "the merged signal ignored the loop abort").toBe(true);

    // And the other direction: Esc aborts the step, not the loop.
    const loop2 = new AbortController();
    const step2 = new AbortController();
    const m2 = anySignalAborted(loop2.signal, step2.signal);
    step2.abort(new Error("esc"));
    expect(m2.signal.aborted, "the merged signal ignored the step abort").toBe(true);
    expect(loop2.signal.aborted, "Esc reached the whole-loop signal").toBe(false);
    m2.dispose();
  });

  it("passes an already-aborted signal straight through", async () => {
    const { anySignalAborted } = await import("../../../src/agent/agent.js");

    const dead = new AbortController();
    dead.abort(new Error("already gone"));
    const { signal } = anySignalAborted(dead.signal, new AbortController().signal);

    expect(signal.aborted, "an already-aborted input was not passed through").toBe(true);
  });

  it("survives dispose being called twice", async () => {
    const { anySignalAborted } = await import("../../../src/agent/agent.js");

    const { dispose, signal } = anySignalAborted(
      new AbortController().signal,
      new AbortController().signal,
    );
    dispose();
    expect(() => dispose()).not.toThrow();
    expect(signal).toBeTruthy();
  });
});
