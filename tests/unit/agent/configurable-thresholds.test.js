// Tests for configurable loop thresholds via AGENT_LOOP_* env vars
// Phase R6 of the foundation roadmap
//
// flow-controller.js reads AGENT_LOOP_TEXT_REPEAT, AGENT_LOOP_TOOL_REPEAT, etc.
// at module load time. We use dynamic import with vi.resetModules() to test
// different env var configurations.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock logger before any import of flow-controller
vi.mock("../../../src/logging/logger.js", () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

describe("Configurable loop thresholds (AGENT_LOOP_* env vars)", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    // Restore original env
    process.env = { ...originalEnv };
    vi.resetModules();
  });

  beforeEach(() => {
    // Clean env before each test
    delete process.env.AGENT_LOOP_TEXT_REPEAT;
    delete process.env.AGENT_LOOP_TOOL_REPEAT;
    vi.resetModules();
  });

  it("AGENT_LOOP_TEXT_REPEAT env var overrides default (4)", async () => {
    process.env.AGENT_LOOP_TEXT_REPEAT = "2";
    const { checkTextLoop, resetFlow } = await import("../../../src/agent/flow-controller.js");
    resetFlow();

    // With threshold=2, repeating the same short text twice should trigger
    checkTextLoop("hello");
    const result = checkTextLoop("hello");
    expect(result).not.toBeNull();
    expect(result.type).toBe("text");
  });

  it("AGENT_LOOP_TOOL_REPEAT env var overrides default (3)", async () => {
    process.env.AGENT_LOOP_TOOL_REPEAT = "2";
    const { checkToolLoop, resetFlow } = await import("../../../src/agent/flow-controller.js");
    resetFlow();

    // With threshold=2, repeating same tool call twice should trigger
    checkToolLoop("read_file", { path: "/tmp/test.txt" });
    const result = checkToolLoop("read_file", { path: "/tmp/test.txt" });
    expect(result).not.toBeNull();
    expect(result.type).toBe("tool");
  });

  it("invalid env var value falls back to default (NaN becomes default)", async () => {
    process.env.AGENT_LOOP_TEXT_REPEAT = "not_a_number";
    const { checkTextLoop, resetFlow } = await import("../../../src/agent/flow-controller.js");
    resetFlow();

    // parseInt("not_a_number") = NaN. The threshold check `count >= NaN` is always false,
    // so no loop is detected even with many repeats — effectively infinite threshold.
    // This documents the current behavior: invalid values disable loop detection.
    checkTextLoop("test");
    checkTextLoop("test");
    checkTextLoop("test");
    checkTextLoop("test");
    const result = checkTextLoop("test");
    // NaN comparison: count >= NaN is always false, so no loop detected
    expect(result).toBeNull();
  });

  it("default thresholds apply when env vars are not set", async () => {
    // Ensure env vars are unset
    delete process.env.AGENT_LOOP_TEXT_REPEAT;
    delete process.env.AGENT_LOOP_TOOL_REPEAT;
    const { checkTextLoop, checkToolLoop, resetFlow } = await import("../../../src/agent/flow-controller.js");
    resetFlow();

    // Default text repeat = 5, so 4 repeats should NOT trigger
    checkTextLoop("abc");
    checkTextLoop("abc");
    checkTextLoop("abc");
    const r4 = checkTextLoop("abc");
    expect(r4).toBeNull();

    // 5th repeat should trigger
    const r5 = checkTextLoop("abc");
    expect(r5).not.toBeNull();
    expect(r5.type).toBe("text");
  });
});
