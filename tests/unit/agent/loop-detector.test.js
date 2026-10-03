// Tests for unified loop detector
import { describe, it, expect, beforeEach } from "vitest";
import {
  checkTextLoop, checkToolLoop, checkDesktopLoop,
  resetDesktopOnMeaningfulText, resetFlow as resetLoopDetector, getThresholds,
} from "../../../src/agent/flow-controller.js";

beforeEach(() => {
  resetLoopDetector();
});

describe("checkTextLoop", () => {
  it("returns null for non-repeating text", () => {
    expect(checkTextLoop("hello")).toBeNull();
    expect(checkTextLoop("world")).toBeNull();
    expect(checkTextLoop("foo")).toBeNull();
  });

  it("returns null for long text (>=100 chars)", () => {
    const long = "a".repeat(100);
    for (let i = 0; i < 5; i++) expect(checkTextLoop(long)).toBeNull();
  });

  it("detects text repeated 5x", () => {
    checkTextLoop("same");
    checkTextLoop("same");
    checkTextLoop("same");
    checkTextLoop("same");
    const result = checkTextLoop("same");
    expect(result).not.toBeNull();
    expect(result.type).toBe("text");
    expect(result.count).toBe(5);
  });

  it("first detection suggests replan, not stop", () => {
    for (let i = 0; i < 4; i++) checkTextLoop("loop");
    const result = checkTextLoop("loop");
    expect(result.action).toBe("replan");
    expect(result.message).toContain("DIFFERENT strategy");
  });

  it("after MAX_REPLANS (3), suggests stop on fourth loop", () => {
    // Loop 1 → replan (replanCount=1)
    for (let i = 0; i < 4; i++) checkTextLoop("a");
    const r1 = checkTextLoop("a");
    expect(r1.action).toBe("replan");

    // Loop 2 → replan (replanCount=2)
    for (let i = 0; i < 4; i++) checkTextLoop("b");
    const r2 = checkTextLoop("b");
    expect(r2.action).toBe("replan");

    // Loop 3 → replan (replanCount=3)
    for (let i = 0; i < 4; i++) checkTextLoop("c");
    const r3 = checkTextLoop("c");
    expect(r3.action).toBe("replan");

    // Loop 4 → stop (replanCount=4 > MAX_REPLANS=3)
    for (let i = 0; i < 4; i++) checkTextLoop("d");
    const r4 = checkTextLoop("d");
    expect(r4.action).toBe("stop");
    expect(r4.message).toContain("Re-plan failed");
  });
});

describe("checkToolLoop", () => {
  it("returns null for different tools", () => {
    expect(checkToolLoop("read_file", { path: "a.js" })).toBeNull();
    expect(checkToolLoop("write_file", { path: "b.js" })).toBeNull();
    expect(checkToolLoop("run_command", { command: "ls" })).toBeNull();
  });

  it("detects same tool repeated 5x (default threshold)", () => {
    for (let i = 0; i < 4; i++) checkToolLoop("read_file", { path: "a.js" });
    const result = checkToolLoop("read_file", { path: "a.js" });
    expect(result).not.toBeNull();
    expect(result.type).toBe("tool");
    expect(result.count).toBe(5);
  });

  it("higher threshold for screenshot (7x)", () => {
    for (let i = 0; i < 6; i++) {
      expect(checkToolLoop("desktop_screenshot", { desktop_id: "d1" })).toBeNull();
    }
    const result = checkToolLoop("desktop_screenshot", { desktop_id: "d1" });
    expect(result).not.toBeNull();
    expect(result.count).toBe(7);
  });

  it("higher threshold for shell commands (8x)", () => {
    for (let i = 0; i < 7; i++) {
      expect(checkToolLoop("desktop_shell", { command: "ls" })).toBeNull();
    }
    const result = checkToolLoop("desktop_shell", { command: "ls" });
    expect(result).not.toBeNull();
  });

  it("fuzzy matches coordinates (50px grid)", () => {
    // All coords round to same 50px grid cell (100,200)
    checkToolLoop("desktop_click", { x: 100, y: 200 });
    checkToolLoop("desktop_click", { x: 105, y: 205 });
    checkToolLoop("desktop_click", { x: 110, y: 210 });
    checkToolLoop("desktop_click", { x: 115, y: 215 });
    const result = checkToolLoop("desktop_click", { x: 120, y: 220 }); // 5th, same grid
    expect(result).not.toBeNull();
  });

  it("does not match different coordinates", () => {
    checkToolLoop("desktop_click", { x: 100, y: 200 });
    checkToolLoop("desktop_click", { x: 100, y: 200 });
    const result = checkToolLoop("desktop_click", { x: 500, y: 500 }); // different grid
    expect(result).toBeNull();
  });

  it("first detection = replan, not stop", () => {
    for (let i = 0; i < 4; i++) checkToolLoop("read_file", { path: "a.js" });
    const result = checkToolLoop("read_file", { path: "a.js" });
    expect(result.action).toBe("replan");
  });
});

describe("checkDesktopLoop", () => {
  const observation = [{ function: { name: "desktop_screenshot" } }];
  const action = [{ function: { name: "desktop_shell" } }];

  it("returns null for mixed observations and actions", () => {
    expect(checkDesktopLoop(observation)).toBeNull();
    expect(checkDesktopLoop(action)).toBeNull();
    expect(checkDesktopLoop(observation)).toBeNull();
  });

  it("detects 8 consecutive observations without action", () => {
    for (let i = 0; i < 7; i++) {
      expect(checkDesktopLoop(observation)).toBeNull();
    }
    const result = checkDesktopLoop(observation);
    expect(result).not.toBeNull();
    expect(result.type).toBe("desktop");
  });

  it("resets counter on action", () => {
    for (let i = 0; i < 6; i++) checkDesktopLoop(observation);
    checkDesktopLoop(action); // reset
    for (let i = 0; i < 7; i++) {
      expect(checkDesktopLoop(observation)).toBeNull();
    }
  });

  it("non-desktop tools count as action", () => {
    for (let i = 0; i < 6; i++) checkDesktopLoop(observation);
    checkDesktopLoop([{ function: { name: "read_file" } }]); // non-desktop = action
    for (let i = 0; i < 7; i++) {
      expect(checkDesktopLoop(observation)).toBeNull();
    }
  });
});

describe("resetDesktopOnMeaningfulText", () => {
  const observation = [{ function: { name: "desktop_screenshot" } }];

  it("resets counter on 'done' text", () => {
    for (let i = 0; i < 6; i++) checkDesktopLoop(observation);
    resetDesktopOnMeaningfulText("Task is done.");
    for (let i = 0; i < 7; i++) {
      expect(checkDesktopLoop(observation)).toBeNull();
    }
  });

  it("does not reset on unrelated text", () => {
    for (let i = 0; i < 7; i++) checkDesktopLoop(observation);
    resetDesktopOnMeaningfulText("Looking at the screen...");
    const result = checkDesktopLoop(observation);
    expect(result).not.toBeNull();
  });
});

describe("getThresholds", () => {
  it("returns all threshold values", () => {
    const t = getThresholds();
    expect(t.textRepeat).toBe(5);
    expect(t.toolRepeat).toBe(5);
    expect(t.toolRepeatScreenshot).toBe(7);
    expect(t.toolRepeatCommand).toBe(8);
    expect(t.desktopObservations).toBe(8);
  });
});

describe("resetLoopDetector", () => {
  it("clears all state", () => {
    // Build up state
    checkTextLoop("same");
    checkTextLoop("same");
    checkToolLoop("read_file", { path: "a" });
    checkToolLoop("read_file", { path: "a" });
    checkDesktopLoop([{ function: { name: "desktop_screenshot" } }]);

    // Reset
    resetLoopDetector();

    // Nothing should trigger
    expect(checkTextLoop("same")).toBeNull();
    expect(checkToolLoop("read_file", { path: "a" })).toBeNull();
    expect(checkDesktopLoop([{ function: { name: "desktop_screenshot" } }])).toBeNull();
  });
});
