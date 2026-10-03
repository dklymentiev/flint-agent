// A child agent's idle timeout must not fire while it works (2026-10-02:
// agent@3010 shut down one minute into a research task).
import { describe, it, expect } from "vitest";
import { childBusy } from "../../src/child-idle.js";

describe("childBusy", () => {
  it("is busy during a turn, with queued work, or with a task in flight", () => {
    expect(childBusy({ agentStatus: "calling-tool" })).toBe(true);
    expect(childBusy({ agentStatus: "thinking" })).toBe(true);
    expect(childBusy({ processing: true, agentStatus: "idle" })).toBe(true);
    expect(childBusy({ processingCount: 1 })).toBe(true);
    expect(childBusy({ agentStatus: "idle", abortController: new AbortController() })).toBe(true);
  });

  it("is idle only when nothing at all is going on", () => {
    expect(childBusy({ processing: false, processingCount: 0, agentStatus: "idle", abortController: null })).toBe(false);
    expect(childBusy()).toBe(false);
  });
});
