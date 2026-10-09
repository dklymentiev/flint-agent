// The headless result record (src/headless-run.js): every number is the run's,
// counted the same way, whichever way the run ended.
import { describe, it, expect } from "vitest";
import { buildHeadlessResult, runTotals } from "../../src/headless-run.js";

const state = (o = {}) => ({
  sessionCost: 0, sessionPromptTokens: 0, sessionCompletionTokens: 0, sessionCachedTokens: 0,
  totalToolCalls: 0, deniedCalls: 0, lastSummary: "", model: "m", ...o,
});
const build = (o) => buildHeadlessResult({
  stopReason: "done", result: null, baseline: runTotals(state()), durationMs: 5, model: "fallback", modifiedFiles: [], ...o,
});

describe("buildHeadlessResult", () => {
  it("reports the run's totals, not the last turn's own figures", () => {
    // Two turns happened; the last one alone cost 0.01 and 30 tokens.
    const lastTurn = { text: "second answer", stats: { cost: 0.01, promptTokens: 20, completionTokens: 10, cachedTokens: 0 } };
    const out = build({
      result: lastTurn,
      state: state({ sessionCost: 0.05, sessionPromptTokens: 400, sessionCompletionTokens: 60, sessionCachedTokens: 90, totalToolCalls: 4, deniedCalls: 1 }),
    });
    expect(out.response).toBe("second answer");
    expect(out.cost).toBe(0.05);
    expect(out.tokens).toBe(460);
    expect(out.tokens_obj).toEqual({ prompt: 400, completion: 60, cached: 90 });
    expect(out.tool_calls).toBe(4);
    expect(out.denied_calls).toBe(1);
  });

  it("subtracts what a resumed session had before this run", () => {
    const before = state({ sessionCost: 1, sessionPromptTokens: 1000, sessionCompletionTokens: 100, totalToolCalls: 7, deniedCalls: 2 });
    const out = build({
      baseline: runTotals(before),
      state: state({ sessionCost: 1.25, sessionPromptTokens: 1300, sessionCompletionTokens: 150, totalToolCalls: 9, deniedCalls: 2 }),
    });
    expect(out.cost).toBeCloseTo(0.25, 9);
    expect(out.tokens).toBe(350);
    expect(out.tool_calls).toBe(2);
    expect(out.denied_calls).toBe(0);
  });

  it("has the same keys on every stop path, and only the documented ones", () => {
    const keys = ["response", "cost", "tokens", "repoClaimGap", "model", "stop_reason", "duration_ms",
      "tool_calls", "denied_calls", "modified_files", "tokens_obj"];
    for (const stopReason of ["done", "time", "killed"]) {
      const out = build({ stopReason, state: state({ lastSummary: "so far" }), modifiedFiles: ["?? a.txt"] });
      expect(Object.keys(out)).toEqual(keys);
      expect(out.stop_reason).toBe(stopReason);
      expect(out.response).toBe("so far");
      expect(out.modified_files).toEqual(["?? a.txt"]);
    }
  });
});
