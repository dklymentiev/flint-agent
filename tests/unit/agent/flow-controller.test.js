// Tests for Flow Controller
import { describe, it, expect, beforeEach } from "vitest";
import {
  checkTextLoop, checkToolLoop, checkDesktopLoop,
  resetDesktopOnMeaningfulText, resetFlow, getThresholds,
  shouldContinue, isLearningOpportunity,
} from "../../../src/agent/flow-controller.js";

beforeEach(() => { resetFlow(); });

describe("loop detection", () => {
  it("detects text repeated 5x", () => {
    checkTextLoop("same"); checkTextLoop("same"); checkTextLoop("same"); checkTextLoop("same");
    expect(checkTextLoop("same")).not.toBeNull();
  });

  it("detects tool repeated 5x", () => {
    checkToolLoop("read_file", { path: "a.js" });
    checkToolLoop("read_file", { path: "a.js" });
    checkToolLoop("read_file", { path: "a.js" });
    checkToolLoop("read_file", { path: "a.js" });
    expect(checkToolLoop("read_file", { path: "a.js" })).not.toBeNull();
  });

  it("first detection = replan, after MAX_REPLANS = stop", () => {
    for (let i = 0; i < 4; i++) checkTextLoop("a");
    const r1 = checkTextLoop("a");
    expect(r1.action).toBe("replan");

    for (let i = 0; i < 4; i++) checkTextLoop("b");
    const r2 = checkTextLoop("b");
    expect(r2.action).toBe("replan");

    for (let i = 0; i < 4; i++) checkTextLoop("c");
    const r3 = checkTextLoop("c");
    expect(r3.action).toBe("replan");

    for (let i = 0; i < 4; i++) checkTextLoop("d");
    expect(checkTextLoop("d").action).toBe("stop");
  });

  it("detects desktop loop at 8 observations", () => {
    const obs = [{ function: { name: "desktop_screenshot" } }];
    for (let i = 0; i < 7; i++) expect(checkDesktopLoop(obs)).toBeNull();
    expect(checkDesktopLoop(obs)).not.toBeNull();
  });

  it("resets desktop on meaningful text", () => {
    const obs = [{ function: { name: "desktop_screenshot" } }];
    for (let i = 0; i < 6; i++) checkDesktopLoop(obs);
    resetDesktopOnMeaningfulText("Task is done.");
    for (let i = 0; i < 7; i++) expect(checkDesktopLoop(obs)).toBeNull();
  });
});

describe("shouldContinue", () => {
  it("no plan + done = stop", () => {
    const r = shouldContinue({ stopReason: "done", plan: null, isApiScoped: false });
    expect(r.action).toBe("stop");
  });

  it("no plan + loop = stop", () => {
    const r = shouldContinue({ stopReason: "loop", plan: null, isApiScoped: false });
    expect(r.action).toBe("stop");
  });

  it("plan with pending tasks = continue", () => {
    const plan = { goalId: 1, tasks: [{ id: 1, title: "test", status: "pending" }] };
    const r = shouldContinue({ stopReason: "done", plan, isApiScoped: false });
    expect(r.action).toBe("continue");
    expect(r.prompt).toContain("test");
  });

  it("plan all done + API scope = stop with goalComplete", () => {
    const plan = { goalId: 42, tasks: [{ id: 1, title: "test", status: "done" }] };
    const r = shouldContinue({ stopReason: "done", plan, isApiScoped: true, apiGoalId: 42 });
    expect(r.action).toBe("stop");
    expect(r.goalComplete).toBe(true);
  });

  it("plan all done + TUI = continue (check other goals)", () => {
    const plan = { goalId: 1, tasks: [{ id: 1, title: "test", status: "done" }] };
    const r = shouldContinue({ stopReason: "done", plan, isApiScoped: false });
    expect(r.action).toBe("continue");
  });

  it("retries exhausted = continue with skip prompt", () => {
    const plan = { goalId: 1, tasks: [{ id: 1, title: "test", status: "pending" }] };
    // Exhaust retries
    for (let i = 0; i < 3; i++) {
      shouldContinue({ stopReason: "done", plan, isApiScoped: false });
    }
    const r = shouldContinue({ stopReason: "done", plan, isApiScoped: false });
    expect(r.action).toBe("continue");
    expect(r.prompt).toContain("retries");
  });

  // API self-continue is opt-in: an API message that creates a plan with
  // pending tasks does not keep going on its own. The caller must set
  // `self_continue: true` (which sets app.autonomous) to enable it.
  it("API scope + pending plan + no self-continue = stop", () => {
    const plan = { goalId: 1, tasks: [{ id: 1, title: "test", status: "pending" }] };
    const r = shouldContinue({ stopReason: "done", plan, isApiScoped: true, apiGoalId: 1, apiSelfContinue: false });
    expect(r.action).toBe("stop");
    expect(r.reason).toBe("api_self_continue_not_enabled");
  });

  it("API scope + pending plan + self-continue opt-in = continue", () => {
    const plan = { goalId: 1, tasks: [{ id: 1, title: "test", status: "pending" }] };
    const r = shouldContinue({ stopReason: "done", plan, isApiScoped: true, apiGoalId: 1, apiSelfContinue: true });
    expect(r.action).toBe("continue");
    expect(r.prompt).toContain("test");
  });

  it("TUI auto (isApiScoped=false) + pending plan = continue regardless", () => {
    const plan = { goalId: 1, tasks: [{ id: 1, title: "test", status: "pending" }] };
    const r = shouldContinue({ stopReason: "done", plan, isApiScoped: false, apiGoalId: null, apiSelfContinue: false });
    expect(r.action).toBe("continue");
    expect(r.prompt).toContain("test");
  });
});

describe("isLearningOpportunity", () => {
  it("true for multi-step plan", () => {
    const plan = { tasks: [{ id: 1 }, { id: 2 }] };
    expect(isLearningOpportunity({ plan, toolCallCount: 3 })).toBe(true);
  });

  it("true for many tool calls", () => {
    expect(isLearningOpportunity({ plan: null, toolCallCount: 10 })).toBe(true);
  });

  it("false for simple task", () => {
    expect(isLearningOpportunity({ plan: null, toolCallCount: 2 })).toBe(false);
  });
});

describe("getThresholds", () => {
  it("returns configurable thresholds", () => {
    const t = getThresholds();
    expect(t.textRepeat).toBe(5);
    expect(t.toolRepeat).toBe(5);
    expect(t.coordGridPx).toBe(50);
  });
});
