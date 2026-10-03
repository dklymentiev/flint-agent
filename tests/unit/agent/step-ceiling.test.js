// What a turn is told about its own ceiling, and what it says when it hits it.

import { describe, it, expect } from "vitest";
import { budgetPressureNote, cutShortNote } from "../../../src/agent/agent.js";

/** Walk a turn step by step and record which warnings arrived, and when. */
function warningsOverATurn(ceiling) {
  const sent = { notice: false };
  const fired = [];
  for (let step = 1; step <= ceiling; step++) {
    const note = budgetPressureNote(step, ceiling, sent);
    if (note) fired.push({ step, note });
  }
  return fired;
}

describe("a turn approaching its ceiling", () => {
  // Stated as the operator would: a repair task is classified complex_multi,
  // capped at 30 steps, while the global limit is 50. The warnings used to be
  // divided by 50, so they landed on steps 25, 35 and 45 while the turn died
  // at 30. The one warning the model ever saw said twenty five steps were left
  // when five were, and it was cut off mid-edit.
  const INTENT_CEILING = 30;

  it("warns once, before the end", () => {
    // One late note instead of three tiers from the halfway mark.
    const fired = warningsOverATurn(INTENT_CEILING);
    expect(fired.length).toBe(1);
    expect(fired[0].step).toBeLessThan(INTENT_CEILING);
  });

  it("does not tell the model to stop", () => {
    // The tiers said "final response NOW" while the fix was unwritten.
    const [{ note }] = warningsOverATurn(INTENT_CEILING);
    expect(note).not.toMatch(/\bNOW\b|final response|consolidat/i);
  });

  it("tells the truth about how many steps are left", () => {
    const fired = warningsOverATurn(INTENT_CEILING);
    for (const { step, note } of fired) {
      const left = INTENT_CEILING - step;
      // Whatever the wording, the number in it has to be the real one. The old
      // code said 25 remaining out of 50 on a turn that had five left.
      expect(note).toContain(String(left));
      expect(note).not.toMatch(/\/50\b/);
    }
  });

  it("gives the last warning early enough to be worth anything", () => {
    const fired = warningsOverATurn(INTENT_CEILING);
    const last = fired[fired.length - 1];
    // At least a couple of steps of runway: a warning on the final step is a
    // postmortem, not a warning.
    expect(INTENT_CEILING - last.step).toBeGreaterThanOrEqual(2);
  });

  it("still warns on a turn with a tight ceiling", () => {
    // A five-step class must not be silent until it is over.
    const fired = warningsOverATurn(5);
    expect(fired.length).toBeGreaterThan(0);
    expect(fired[0].step).toBeLessThan(5);
  });

  it("does not repeat the note once sent", () => {
    const sent = { notice: false };
    const first = budgetPressureNote(24, 30, sent);
    const again = budgetPressureNote(25, 30, sent);
    expect(first).toBeTruthy();
    expect(again).toBeNull();
  });
});

describe("a turn that ran out of steps", () => {
  it("names the files it changed, so they are not left unmentioned", () => {
    const note = cutShortNote(["/work/src/a.js", "/work/src/b.js"], 30, ["/work"]);
    expect(note).toContain("/work/src/a.js");
    expect(note).toContain("/work/src/b.js");
    expect(note).toContain("30");
  });

  it("says plainly when it changed nothing, and where it looked", () => {
    const note = cutShortNote([], 12, ["/work"]);
    expect(note).toMatch(/no file changed/i);
    expect(note).toContain("/work");
    expect(note).toContain("12");
  });

  it("claims nothing about the files when the folders could not be read", () => {
    const note = cutShortNote(null, 12, ["/work"]);
    expect(note).toContain("12");
    expect(note).not.toMatch(/changed/i);
  });
});