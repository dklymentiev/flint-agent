// Regression test for v1.0.1 fix: drain loop respects user interrupt (#9)
//
// Bug: flow-controller.shouldContinue() only checked plan.tasks.some(pending).
// When user typed "стоп" / "не надо" during an autonomous plan, the drain
// loop kept generating Continue messages because shouldContinue returned
// {action: "continue", prompt: "Continue: Task X..."} regardless of user
// intent. The user feedback was ignored; plan tasks were auto-marked done.
//
// Fix: added _userInterrupted flag. Drain loop sets it on any non-
// self-continue message during autonomous mode. shouldContinue() checks
// the flag and returns {action: "stop", reason: "user_interrupt"} when set.
// resetFlow() (called by /new) clears it.
//
// Commits: 64d2c70 (flow-controller), same (drain-loop.js)

import { describe, it, expect, beforeEach } from "vitest";
import {
  shouldContinue,
  setUserInterrupt,
  isUserInterrupted,
  resetFlow,
  resetTurn,
} from "../../../src/agent/flow-controller.js";

function makePlan() {
  return {
    goalId: 100,
    tasks: [
      { id: 1, status: "done" },
      { id: 2, status: "in_progress" },
      { id: 3, status: "pending" },
    ],
  };
}

describe("flow-controller — user interrupt (v1.0.1 fix)", () => {
  beforeEach(() => {
    resetFlow();
  });

  it("default state: no interrupt", () => {
    expect(isUserInterrupted()).toBe(false);
  });

  it("setUserInterrupt(true) sets the flag", () => {
    setUserInterrupt(true);
    expect(isUserInterrupted()).toBe(true);
  });

  it("shouldContinue returns continue on active plan without interrupt", () => {
    const decision = shouldContinue({ stopReason: "end_turn", plan: makePlan() });
    expect(decision.action).toBe("continue");
    expect(decision.prompt).toContain("Continue:");
  });

  it("shouldContinue returns stop when interrupt is set, even on active plan", () => {
    setUserInterrupt(true);
    const decision = shouldContinue({ stopReason: "end_turn", plan: makePlan() });
    expect(decision.action).toBe("stop");
    expect(decision.reason).toBe("user_interrupt");
  });

  it("interrupt persists across multiple shouldContinue calls", () => {
    setUserInterrupt(true);
    for (let i = 0; i < 5; i++) {
      const decision = shouldContinue({ stopReason: "end_turn", plan: makePlan() });
      expect(decision.action).toBe("stop");
      expect(decision.reason).toBe("user_interrupt");
    }
  });

  it("setUserInterrupt(false) clears the flag, shouldContinue resumes", () => {
    setUserInterrupt(true);
    expect(shouldContinue({ stopReason: "end_turn", plan: makePlan() }).action).toBe("stop");

    setUserInterrupt(false);
    expect(shouldContinue({ stopReason: "end_turn", plan: makePlan() }).action).toBe("continue");
  });

  it("resetFlow() clears interrupt flag (matches /new semantics)", () => {
    setUserInterrupt(true);
    expect(isUserInterrupted()).toBe(true);

    resetFlow();

    expect(isUserInterrupted()).toBe(false);
    const decision = shouldContinue({ stopReason: "end_turn", plan: makePlan() });
    expect(decision.action).toBe("continue");
  });

  // resetTurn() runs at the top of every agent invocation. When that was
  // resetFlow(), the interrupt set by the drain loop was cleared before
  // shouldContinue read it, and the retry cap never counted past one.
  it("resetTurn() keeps the interrupt set by the drain loop", () => {
    setUserInterrupt(true);
    resetTurn();
    const decision = shouldContinue({ stopReason: "end_turn", plan: makePlan() });
    expect(decision.action).toBe("stop");
    expect(decision.reason).toBe("user_interrupt");
  });

  it("resetTurn() keeps per-task retry counts, so the retry cap is reached", () => {
    const plan = { goalId: 100, tasks: [{ id: 7, title: "stuck", status: "pending" }] };
    const prompts = [];
    for (let i = 0; i < 4; i++) {
      resetTurn();
      prompts.push(shouldContinue({ stopReason: "done", plan }).prompt);
    }
    expect(prompts[0]).toContain("Continue:");
    expect(prompts[1]).toContain("retry 1/3");
    expect(prompts[3]).toContain("exhausted retries");
  });

  it("interrupt takes precedence over no-plan stop", () => {
    // Even with no plan, if interrupted, return stop with user_interrupt reason.
    // This covers the edge case where plan was closed but interrupt flag wasn't cleared.
    setUserInterrupt(true);
    const decision = shouldContinue({ stopReason: "end_turn", plan: null });
    expect(decision.action).toBe("stop");
    expect(decision.reason).toBe("user_interrupt");
  });
});
