// A turn that was supposed to change something and did not.
//
// The checks look at two things only: did anything change, and was it said.
// Never at the wording, which is criterion 4: the model writes the sentence,
// the loop only guarantees that a sentence exists and that the facts around it
// are true.

import { describe, it, expect } from "vitest";
import { noChangeReckoning } from "../../../src/agent/agent.js";
import { INTENTS, resolveIntent } from "../../../src/agent/intent-manifest.js";

describe("a turn that changed nothing", () => {
  it("says so when the class was supposed to change something", () => {
    const r = noChangeReckoning({ changes: "yes", filesChanged: 0, toolCallsMade: 4 });
    expect(r).not.toBeNull();
    expect(r.note).toBeTruthy();
  });

  it("says so for the catch-all class, which is where repair work lands", () => {
    // The run behind this task was classified complex_multi: 38 tool calls,
    // none of them a write, and an answer that read like finished work.
    expect(resolveIntent("complex_multi").changes).not.toBe("no");
    const r = noChangeReckoning({ changes: "maybe", filesChanged: 0, toolCallsMade: 38 });
    expect(r).not.toBeNull();
  });

  it("asks the model which of the three outcomes it was", () => {
    // Which of "did not find it", "did not apply it" and "nothing to change"
    // applies is known only to the model, so it is asked.
    const untried = noChangeReckoning({ changes: "maybe", filesChanged: 0, toolCallsMade: 38 });
    expect(untried.ask).toBeTruthy();
    // The question offers all three, and does not suggest which is true.
    expect(untried.ask).toMatch(/did not find/i);
    expect(untried.ask).toMatch(/did not apply|not apply/i);
    expect(untried.ask).toMatch(/nothing to change/i);
  });

  it("stays silent when something did change", () => {
    expect(noChangeReckoning({ changes: "yes", filesChanged: 1, toolCallsMade: 2 })).toBeNull();
    expect(noChangeReckoning({ changes: "maybe", filesChanged: 3, toolCallsMade: 6 })).toBeNull();
  });

  it("stays silent when the turn touched no tool at all", () => {
    // The model answered out of its own head. It was not attempting anything,
    // and a note on every ordinary answer would be noise. Found by an existing
    // test, which asserted the exact text of a plain reply.
    expect(noChangeReckoning({ changes: "maybe", filesChanged: 0, toolCallsMade: 0 })).toBeNull();
    expect(noChangeReckoning({ changes: "yes", filesChanged: 0, toolCallsMade: 0 })).toBeNull();
  });

  it("stays silent when the request was never about changing anything", () => {
    expect(noChangeReckoning({ changes: "no", filesChanged: 0, toolCallsMade: 3 })).toBeNull();
    // Reading a file and answering a question are not failures to write one.
    expect(INTENTS.file_read.changes).toBe("no");
    expect(INTENTS.knowledge_qa.changes).toBe("no");
    expect(INTENTS.web_search.changes).toBe("no");
  });

  it("treats an unknown class as one that might have changed something", () => {
    // A failed classification must not buy silence: the safe default is to
    // account for the turn, not to assume it was only a question.
    expect(noChangeReckoning({ filesChanged: 0, toolCallsMade: 7 })).not.toBeNull();
  });

  it("every class in the catalog says which it is", () => {
    for (const [name, spec] of Object.entries(INTENTS)) {
      expect(["yes", "no", "maybe"], `${name} is unlabelled`).toContain(spec.changes);
    }
  });

  it("claims nothing when the folders could not be read", () => {
    // Too big to snapshot is unknown, not "nothing changed".
    expect(noChangeReckoning({ changes: "yes", filesChanged: null, toolCallsMade: 5 })).toBeNull();
  });

  it("names the folders the claim was checked in", () => {
    // A write elsewhere is not seen, so the note vouches only for these.
    const r = noChangeReckoning({ changes: "yes", filesChanged: 0, toolCallsMade: 2, roots: ["/work"] });
    expect(r.note).toContain("/work");
    expect(r.note).not.toMatch(/on disk/i);
  });
});

describe("no classification, no reckoning", () => {
  it("says nothing when it is unknown whether a change was asked for", async () => {
    const { noChangeReckoning } = await import("../../../src/agent/agent.js");
    // The classifier is off or failed: the turn's intent is unknown.
    expect(noChangeReckoning({ changes: "unknown", filesChanged: 0, toolCallsMade: 3, roots: ["/x"] })).toBe(null);
  });
});
