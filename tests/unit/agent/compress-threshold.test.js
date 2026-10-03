// When history may be rewritten to make room.
//
// On the 2026-09-26 auto-budget run the eager pass fired at about 25k tokens,
// turned sixteen file reads into one-line summaries, and the agent spent the
// rest of its 50 steps reading the same files again.

import { describe, it, expect, vi, beforeEach } from "vitest";

const state = { window: null, override: null };

vi.mock("../../../src/config.js", () => ({
  config: {
    get compressAfterTokens() { return state.override; },
    sessionsDir: "/tmp/test-sessions",
  },
}));
vi.mock("../../../src/agent/usage.js", () => ({
  contextWindow: () => state.window,
}));

const { compressThreshold } = await import("../../../src/agent/compression.js");

beforeEach(() => {
  state.window = null;
  state.override = null;
});

describe("compressThreshold", () => {
  it("is half the model's window", () => {
    state.window = 200000;
    expect(compressThreshold()).toBe(100000);
  });

  it("is capped, because a bigger prompt is paid for on every call", () => {
    state.window = 1000000;
    expect(compressThreshold()).toBe(128000);
  });

  it("is 64k when the window is unknown, well above where reads were being lost", () => {
    expect(compressThreshold()).toBe(64000);
  });

  it("yields to an explicit override", () => {
    state.window = 1000000;
    state.override = 30000;
    expect(compressThreshold()).toBe(30000);
  });
});
