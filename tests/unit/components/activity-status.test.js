// The status line says what Flint is doing, and how long THIS has been going.
//
// On 2026-09-29 a model call was sent at 20:40:49 and never came back. For
// ten minutes the console showed `thinking #15 468s`: a number that is the age
// of the TASK, not of the call, so it grew through ten minutes of ordinary
// work too and told the operator nothing about which of the two was happening.

import { describe, it, expect, vi, afterEach } from "vitest";
import { formatElapsed } from "../../../src/components/LiveZone.js";
import { createMockStore } from "../../helpers/mock-store.js";

afterEach(() => { vi.useRealTimers(); });

describe("formatElapsed", () => {
  it("reads as minutes and seconds", () => {
    expect(formatElapsed(45_000)).toBe("0:45");
    expect(formatElapsed(120_000)).toBe("2:00");
  });

  it("reads ten minutes as ten minutes, not as 600", () => {
    expect(formatElapsed(600_000)).toBe("10:00");
  });

  it("never shows a negative or a bare number", () => {
    expect(formatElapsed(-5)).toBe("0:00");
    expect(formatElapsed(0)).toBe("0:00");
  });
});

describe("activity clock", () => {
  it("starts its own clock when the activity changes", () => {
    vi.useFakeTimers();
    const store = createMockStore();
    vi.setSystemTime(new Date("2026-09-29T20:00:00Z"));

    store.getState().setAgentStatus("thinking");
    store.getState().setActivity({ kind: "call", label: "waiting for the model, call 1" });

    vi.setSystemTime(new Date("2026-09-29T20:00:05Z"));
    const first = store.getState().activityStartedAt;

    vi.setSystemTime(new Date("2026-09-29T20:03:00Z"));
    store.getState().setActivity({ kind: "tool", label: "running run_command" });

    // Three minutes of the TURN have passed; the activity clock has not.
    expect(store.getState().activityStartedAt).toBeGreaterThan(first);
    expect(store.getState().activity.label).toBe("running run_command");
  });

  it("is cleared when the turn ends", () => {
    const store = createMockStore();
    store.getState().setActivity({ kind: "call", label: "waiting" });
    store.getState().clearActivity();
    expect(store.getState().activity).toBeNull();
    expect(store.getState().activityStartedAt).toBeNull();
  });
});