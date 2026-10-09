// The headless run loop (src/headless-run.js createHeadlessRun), driven with a
// stand-in for processMessage. No process, no signal, no model: the loop's own
// rules are what is tested.
//
// The rules: a stop that was asked for (the time limit, a signal) always ends
// the run, always with the reason that asked first, always with exit code 2.
// It does not depend on a turn being in flight at that moment, nor on the turn
// noticing.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHeadlessRun, installHeadlessSignals, VERIFY_MESSAGE } from "../../src/headless-run.js";

/** What processMessage does around the agent loop: a controller while it runs. */
function fakeTurns(app, script) {
  const calls = [];
  const processMessage = vi.fn(async (content, name, opts = {}) => {
    calls.push(content);
    const step = script[calls.length - 1];
    if (!step) throw new Error("unexpected turn " + calls.length);
    app.abortController = new AbortController();
    if (opts.signal?.aborted) app.abortController.abort(opts.signal.reason);
    else opts.signal?.addEventListener("abort", () => app.abortController?.abort(opts.signal.reason), { once: true });
    try {
      return await step({ signal: app.abortController.signal, endLoop: () => { app.abortController = null; } });
    } finally {
      app.abortController = null;
    }
  });
  return { processMessage, calls };
}

/** Rejects like the agent loop when its signal aborts; never resolves otherwise. */
const untilAborted = ({ signal }) => new Promise((_, reject) => {
  const fail = () => reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
  if (signal.aborted) fail(); else signal.addEventListener("abort", fail, { once: true });
});

function harness(script, { changes = "x" } = {}) {
  const app = { abortController: null, shuttingDown: false, timeLimitHit: false };
  const { processMessage, calls } = fakeTurns(app, script);
  const out = { written: [], code: undefined, errors: [], saved: 0, killed: 0 };
  const run = createHeadlessRun({
    app,
    processMessage,
    saveSession: async () => { out.saved++; },
    buildResult: (stopReason, result) => ({ stop_reason: stopReason, response: result?.text ?? "" }),
    gitChanges: () => changes,
    write: (text, cb) => { out.written.push(JSON.parse(text)); cb?.(); },
    exit: (code) => { if (out.code === undefined) out.code = code; },
    logError: (line) => out.errors.push(line),
    killChildren: () => { out.killed++; },
    graceMs: 5000,
  });
  return { app, run, out, calls };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("headless run loop: --time-limit", () => {
  it("a turn that finishes in time is 'done' with exit 0", async () => {
    const { run, out } = harness([async () => ({ text: "all good", toolCalls: [] })]);
    await run.run({ task: "t", timeLimitSec: 10 });
    expect(out.written).toEqual([expect.objectContaining({ stop_reason: "done", response: "all good" })]);
    expect(out.code).toBe(0);
  });

  it("a model call that hangs is aborted at the limit: 'time', exit 2", async () => {
    const { run, out } = harness([untilAborted]);
    const done = run.run({ task: "t", timeLimitSec: 3 });
    await vi.advanceTimersByTimeAsync(3000);
    await done;
    expect(out.written).toEqual([expect.objectContaining({ stop_reason: "time" })]);
    expect(out.code).toBe(2);
    expect(out.saved).toBe(1);
    expect(out.killed, "the run's commands are killed before the record").toBe(1);
  });

  it("the limit landing after the agent loop ended still reports 'time', exit 2", async () => {
    // The loop is over (its controller is gone) and the turn is saving the
    // session when the limit passes. Nothing is left to abort, and the turn
    // returns normally: that used to print "done" and exit 0.
    const { run, out } = harness([async ({ endLoop }) => {
      endLoop();
      await new Promise((r) => setTimeout(r, 4000));
      return { text: "finished late", toolCalls: [] };
    }]);
    const done = run.run({ task: "t", timeLimitSec: 3 });
    await vi.advanceTimersByTimeAsync(4000);
    await done;
    expect(out.written).toEqual([expect.objectContaining({ stop_reason: "time", response: "finished late" })]);
    expect(out.code).toBe(2);
  });

  it("the limit landing between two turns does not start the second one", async () => {
    // First turn ends with an edit that changed nothing, so auto-verify wants
    // a second turn. The limit passed while no controller existed; the second
    // turn used to start and run with no limit at all.
    const { run, out, calls } = harness([
      async ({ endLoop }) => {
        endLoop();
        await new Promise((r) => setTimeout(r, 4000));
        return { text: "edited", toolCalls: [{ name: "edit_file" }] };
      },
      async () => ({ text: "second turn ran", toolCalls: [] }),
    ], { changes: "" });
    const done = run.run({ task: "t", timeLimitSec: 3 });
    await vi.advanceTimersByTimeAsync(4000);
    await done;
    expect(calls).toEqual(["t"]);
    expect(out.written).toEqual([expect.objectContaining({ stop_reason: "time" })]);
    expect(out.code).toBe(2);
  });

  it("a turn that ignores the abort is left behind after the grace period", async () => {
    const { run, out } = harness([() => new Promise(() => {})]);
    const done = run.run({ task: "t", timeLimitSec: 3 });
    await vi.advanceTimersByTimeAsync(3000);
    expect(out.code, "still inside the grace period").toBeUndefined();
    await vi.advanceTimersByTimeAsync(5000);
    await done;
    expect(out.written).toEqual([expect.objectContaining({ stop_reason: "time" })]);
    expect(out.code).toBe(2);
  });

  it("auto-verify still sends its second message when there is time", async () => {
    const { run, out, calls } = harness([
      async () => ({ text: "edited", toolCalls: [{ name: "edit_file" }] }),
      async () => ({ text: "fixed", toolCalls: [] }),
    ], { changes: "" });
    await run.run({ task: "t", timeLimitSec: 0 });
    expect(calls).toEqual(["t", VERIFY_MESSAGE]);
    expect(out.written).toEqual([expect.objectContaining({ stop_reason: "done", response: "fixed" })]);
    expect(out.code).toBe(0);
  });

  it("an error that nobody asked for is exit 1 and no record", async () => {
    const { run, out } = harness([async () => { throw new Error("provider exploded"); }]);
    await run.run({ task: "t", timeLimitSec: 0 });
    expect(out.written).toEqual([]);
    expect(out.errors.join("")).toContain("provider exploded");
    expect(out.code).toBe(1);
  });
});

// A real SIGTERM cannot be delivered to a Node handler on Windows (the OS
// terminates the process), so the tests that send one are skipped there. The
// handler is called here directly, which runs the same code on every platform.
describe("headless run loop: SIGTERM / SIGINT", () => {
  /** A stand-in for `process`: only what installHeadlessSignals uses. */
  const fakeProcess = () => {
    const listeners = {};
    return {
      on: (sig, fn) => { (listeners[sig] ||= []).push(fn); },
      emit: (sig) => { for (const fn of listeners[sig] || []) fn(); },
      listeners,
    };
  };

  it("a signal during a turn ends the run as 'killed' with exit 2, session saved", async () => {
    const { run, out, app } = harness([untilAborted]);
    const proc = fakeProcess();
    installHeadlessSignals(proc, run);
    const done = run.run({ task: "t", timeLimitSec: 0 });
    await vi.advanceTimersByTimeAsync(100);
    proc.emit("SIGTERM");
    await done;
    expect(app.shuttingDown).toBe(true);
    expect(out.written).toEqual([expect.objectContaining({ stop_reason: "killed" })]);
    expect(out.saved).toBe(1);
    expect(out.code).toBe(2);
  });

  it("a signal before the first turn: no turn starts, the run still ends as 'killed'", async () => {
    // The handler is installed before bootstrap, the first turn starts after
    // it. A signal in between used to find no controller to abort and did not
    // end the process either, so the whole task then ran.
    const { run, out, calls } = harness([async () => ({ text: "the task ran anyway", toolCalls: [] })]);
    const proc = fakeProcess();
    installHeadlessSignals(proc, run);
    proc.emit("SIGTERM");
    await run.run({ task: "t", timeLimitSec: 0 });
    expect(calls).toEqual([]);
    expect(out.written).toEqual([expect.objectContaining({ stop_reason: "killed" })]);
    expect(out.code).toBe(2);
  });

  it("the same signal delivered twice shuts down once", async () => {
    const { run, out } = harness([untilAborted]);
    const proc = fakeProcess();
    installHeadlessSignals(proc, run);
    const done = run.run({ task: "t", timeLimitSec: 0 });
    await vi.advanceTimersByTimeAsync(100);
    proc.emit("SIGTERM");
    proc.emit("SIGTERM");
    await done;
    expect(out.written.length).toBe(1);
    expect(out.saved).toBe(1);
    expect(out.killed).toBe(1);
  });

  it("SIGINT is the same stop", async () => {
    const { run, out } = harness([untilAborted]);
    const proc = fakeProcess();
    installHeadlessSignals(proc, run);
    expect(Object.keys(proc.listeners).sort()).toEqual(["SIGINT", "SIGTERM"]);
    const done = run.run({ task: "t", timeLimitSec: 0 });
    await vi.advanceTimersByTimeAsync(100);
    proc.emit("SIGINT");
    await done;
    expect(out.written).toEqual([expect.objectContaining({ stop_reason: "killed" })]);
    expect(out.code).toBe(2);
  });

  it("a turn that ignores the signal does not keep the process alive", async () => {
    const { run, out } = harness([() => new Promise(() => {})]);
    const proc = fakeProcess();
    installHeadlessSignals(proc, run);
    const done = run.run({ task: "t", timeLimitSec: 0 });
    await vi.advanceTimersByTimeAsync(100);
    proc.emit("SIGTERM");
    await vi.advanceTimersByTimeAsync(5000);
    await done;
    expect(out.code).toBe(2);
  });

  it("the time limit and a signal together: the first reason is reported, exit 2 either way", async () => {
    const { run, out } = harness([untilAborted]);
    const proc = fakeProcess();
    installHeadlessSignals(proc, run);
    const done = run.run({ task: "t", timeLimitSec: 3 });
    await vi.advanceTimersByTimeAsync(100);
    proc.emit("SIGTERM");
    await vi.advanceTimersByTimeAsync(3000);
    await done;
    expect(out.written).toEqual([expect.objectContaining({ stop_reason: "killed" })]);
    expect(out.code).toBe(2);
  });
});
