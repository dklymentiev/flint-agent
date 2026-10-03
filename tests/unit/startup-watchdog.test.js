// The startup watchdog must not kill Flint while it waits for the operator.
//
// Owner, 2026-10-01: on a fresh machine Flint exited with "[WATCHDOG] Startup
// timeout (30s)" while the first-run "How careful should Flint be?" question
// was on screen, waiting for an answer.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

let wd;
let exitSpy;
let sendSpy;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  wd = await import("../../src/startup-watchdog.js");
  exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {});
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  sendSpy = vi.fn();
  process.send = sendSpy;
});

afterEach(() => {
  wd.clearStartupWatchdog();
  delete process.send;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("startup watchdog", () => {
  it("still exits when startup itself hangs", () => {
    wd.startStartupWatchdog();
    vi.advanceTimersByTime(30001);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("does not exit while a question waits for the operator", async () => {
    wd.startStartupWatchdog();
    let answer;
    const waiting = wd.whileWaitingForOperator(() => new Promise((r) => { answer = r; }));
    expect(wd.isStartupWatchdogArmed()).toBe(false);
    vi.advanceTimersByTime(5 * 60 * 1000); // the operator takes five minutes
    expect(exitSpy).not.toHaveBeenCalled();
    answer("n");
    await waiting;
    expect(wd.isStartupWatchdogArmed()).toBe(true);
  });

  it("restarts the full countdown after the answer", async () => {
    wd.startStartupWatchdog();
    vi.advanceTimersByTime(25000);
    await wd.whileWaitingForOperator(async () => "y");
    vi.advanceTimersByTime(25000);
    expect(exitSpy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(5001);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("tells the launcher to stop its spinner before asking", async () => {
    wd.startStartupWatchdog();
    await wd.whileWaitingForOperator(async () => {
      expect(sendSpy).toHaveBeenCalledWith({ type: "flint:ready" });
    });
  });

  it("stays off once startup has finished", async () => {
    wd.startStartupWatchdog();
    wd.clearStartupWatchdog();
    await wd.whileWaitingForOperator(async () => "y");
    expect(wd.isStartupWatchdogArmed()).toBe(false);
    vi.advanceTimersByTime(60000);
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
