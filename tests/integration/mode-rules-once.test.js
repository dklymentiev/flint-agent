// runAgent appended the turn's mode rules to the session's system message
// every turn ("[MODE: project]" twice by the second call, 242 characters more
// each turn; prompt dump, 2026-10-02). The message is kept rather than
// rebuilt, so the prompt cache keeps the tools and the history; the rules go
// on once.
import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/logging/logger.js", () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}));

describe("the mode rules on the system message", () => {
  it("are appended once, and a turn in the same mode leaves the message as it was", async () => {
    const { appendOnce } = await import("../../src/agent/agent.js");
    const rules = "\n\n[MODE: project]\n- Plan before executing.";
    const once = appendOnce("You are FLINT.", rules);
    expect(once).toBe("You are FLINT." + rules);
    expect(appendOnce(once, rules)).toBe(once);
    expect(appendOnce(once, "\n\n[MODE: research]")).toBe(once + "\n\n[MODE: research]");
  });
});

describe("retrying a failed model call", () => {
  it("waits 1 s, then 3 s, instead of retrying at once", async () => {
    const { apiRetryDelayMs } = await import("../../src/agent/agent.js");
    expect(apiRetryDelayMs(1, {})).toBe(1000);
    expect(apiRetryDelayMs(2, {})).toBe(3000);
    expect(apiRetryDelayMs(2, { FLINT_API_RETRY_MS: "0" })).toBe(0);
  });
});
