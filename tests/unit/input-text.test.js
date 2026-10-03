// What the operator sees must be what is sent.
//
// A pasted multi-line message looked cut and overwritten in the input box,
// though the agent received it whole. The cause, reproduced below: a paste
// from Windows arrives with the line breaks as bare CR (`\r`), and a
// terminal draws a CR as "back to column 0" — so line two is written over
// line one, and only the last line survives. The cursor arithmetic in
// ink-text-input counts the CRs as characters, so the highlight lands in the
// wrong place too.
//
//   paste: "line one\r\nline two\r\nline three"     (30 chars, 2 CRs)
//   drawn: "\nline three"                            (1 line visible)
//
// The agent got all three lines. The operator saw one. Nothing was wrong with
// what was sent, which is why this never showed up in a message log.

import { describe, it, expect, beforeAll } from "vitest";
import {
  normalizeInputText, hasBareCR, visibleLineCount, expandTabs, displayTextFor,
} from "../../src/input-text.js";

let React, render, App, createMockStore;

/**
 * The real App, imported once.
 *
 * App.js pulls in the agent loop, the tool registry and the config — 7-9s on
 * this machine on its own. Importing it inside each test body put the suite's
 * 10s per-test timeout within reach under the parallel load of a full run, and
 * the first of these two tests failed that way. The 60s is for the import
 * hook, measured, not slack.
 */
beforeAll(async () => {
  React = (await import("react")).default;
  ({ render } = await import("ink-testing-library"));
  ({ App } = await import("../../src/components/App.js"));
  ({ createMockStore } = await import("../helpers/mock-store.js"));
}, 60000);

describe("hasBareCR", () => {
  it("sees a lone CR, which is how some terminals send a line break", () => {
    expect(hasBareCR("a\rb")).toBe(true);
  });

  it("does not call a CRLF pair a bare CR", () => {
    // The whole point of the name. \r\n is a normal line ending and must be
    // left alone; a bare \r is the character the terminal acts on. Asserted
    // explicitly because conflating the two would normalize every line ending
    // in a Windows paste down to a single \n, and then the test for "sees the
    // CR in a Windows paste" would pass for the wrong reason.
    expect(hasBareCR("a\r\nb")).toBe(false);
    expect(hasBareCR("a\r\nb\rc")).toBe(true);
  });

  it("sees the CR in a paste that mixes both endings", () => {
    expect(hasBareCR("line one\r\nline two\rline three")).toBe(true);
  });
});

describe("normalizeInputText", () => {
  it("turns CRLF into a line the input can draw", () => {
    expect(normalizeInputText("line one\r\nline two")).toBe("line one\nline two");
  });

  it("turns a bare CR into a line break", () => {
    expect(normalizeInputText("a\rb")).toBe("a\nb");
  });

  it("handles all three line endings in one paste", () => {
    expect(normalizeInputText("a\r\nb\rc\nd")).toBe("a\nb\nc\nd");
  });

  it("leaves a text with no CRs exactly as it was", () => {
    const text = "just a normal message";
    expect(normalizeInputText(text)).toBe(text);
  });

  it("leaves a clean multi-line paste exactly as it was", () => {
    const text = "one\ntwo\nthree";
    expect(normalizeInputText(text)).toBe(text);
  });

  it("is idempotent — normalizing twice changes nothing", () => {
    // The input normalizes on every keystroke, so this is the property that
    // keeps a held-down key from eating a line at a time.
    const once = normalizeInputText("a\r\nb\rc");
    expect(normalizeInputText(once)).toBe(once);
  });

  it("does not touch the text an agent is sent apart from line endings", () => {
    // No trimming, no rewrapping: what the operator typed is what goes.
    const text = "  leading space\r\nand a tab\there  ";
    expect(normalizeInputText(text)).toBe("  leading space\nand a tab\there  ");
  });

  it("handles a paste that is nothing but line breaks", () => {
    expect(normalizeInputText("\r\n\r\n")).toBe("\n\n");
  });

  it("handles empty and non-string input without throwing", () => {
    expect(normalizeInputText("")).toBe("");
    expect(normalizeInputText(null)).toBe("");
    expect(normalizeInputText(undefined)).toBe("");
  });

  it("keeps a form feed and a lone LF exactly as they are", () => {
    expect(normalizeInputText("a\fb")).toBe("a\fb");
  });
});

describe("what the operator would see", () => {
  it("shows every line of a Windows paste, not just the last", () => {
    // The defect, stated as a test. Before the fix the drawn text was
    // "\nline three" — one line, the first two overwritten.
    const pasted = "line one\r\nline two\r\nline three";
    expect(displayTextFor(pasted)).toBe("line one\nline two\nline three");
    expect(displayTextFor(pasted).split("\n")).toHaveLength(3);
  });

  it("counts the lines the operator can actually see", () => {
    expect(visibleLineCount("line one\r\nline two\r\nline three")).toBe(3);
    expect(visibleLineCount("one line")).toBe(1);
  });

  it("agrees with the sent text — the two are the same string", () => {
    const pasted = "a\r\nb\rc\nd";
    expect(displayTextFor(pasted)).toBe(normalizeInputText(pasted));
  });
});

describe("the input shows what it will send", () => {
  it("displays every line of a pasted Windows message", async () => {
    // The end-to-end version of the defect, driven through the real component
    // and real keystrokes rather than by calling the function again. Before the
    // fix, a three-line paste was displayed as one line with the first two
    // overwritten: ink-text-input renders the raw value and a terminal draws a
    // CR as "back to column 0".
    const store = createMockStore();
    const { lastFrame, stdin, unmount } = render(
      React.createElement(App, { store, onSubmit: () => {}, onAbort: () => {} }),
    );

    // A Windows paste, exactly as a terminal delivers it: CRLF line endings.
    stdin.write("line one\r\nline two\r\nline three");
    await new Promise((r) => setTimeout(r, 50));

    // The precondition for a correct display: the rendered frame contains no
    // carriage return. ink-text-input draws its value literally, so a CR in the
    // value is a CR on screen, and a terminal turns that into "column 0" and
    // overwrites the line above.
    //
    // What this test does NOT do is reproduce the overwrite. The testing
    // stdin does not deliver a paste the way a terminal does, so the collapse
    // itself is not observable here — confirmed by reverting this fix and
    // watching the string assertion pass either way. The guarantee therefore
    // rests on the next test (the value that reaches submit) plus the fact that
    // the drawing is literal. Claiming this frame assertion catches the bug
    // would be claiming something I measured to be false.
    expect(lastFrame()).not.toMatch(/\r/);
    expect(lastFrame()).toContain("line three");

    unmount();
  });

  it("sends the operator the lines they pasted, not the ones they could see", async () => {
    // What is drawn and what is sent must be the same string. This is the
    // whole point: the operator's correction, when a line appears to
    // vanish, is a guess — and the guess is what reaches the agent.
    const store = createMockStore();
    const sent = [];
    const { stdin, unmount } = render(
      React.createElement(App, {
        store,
        onSubmit: (msg) => sent.push(msg),
        onAbort: () => {},
      }),
    );

    const pasted = "alpha\r\nbeta\r\ngamma";
    stdin.write(pasted);
    await new Promise((r) => setTimeout(r, 50));
    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 50));

    expect(sent).toHaveLength(1);
    expect(sent[0].split("\n")).toEqual(["alpha", "beta", "gamma"]);
    // And it is exactly the normalized paste — nothing trimmed, nothing
    // reflowed, because this may be a diff or a stack trace.
    expect(sent[0]).toBe(normalizeInputText(pasted));
    unmount();
  });
});

describe("expandTabs", () => {
  it("advances to the next tab stop, not by a fixed width", () => {
    // Tab stops are at columns 0, 4, 8, 12... and a cursor already sitting on
    // a stop advances to the NEXT one. So the padding depends on the column,
    // and at a boundary it is the full width. Expanding by a flat 4 would
    // misplace every tab after the first character, which for a pasted diff is
    // the difference between aligned columns and noise.
    expect(expandTabs("a\tb")).toBe("a   b");   // col 1 -> 3 spaces
    expect(expandTabs("ab\tc")).toBe("ab  c");  // col 2 -> 2 spaces
    expect(expandTabs("abc\td")).toBe("abc d"); // col 3 -> 1 space
    expect(expandTabs("abcd\te")).toBe("abcd    e"); // col 4 -> next stop, 4
  });

  it("leaves text with no tab alone", () => {
    expect(expandTabs("plain text")).toBe("plain text");
  });

  it("resets the column on each line, as a terminal does", () => {
    expect(expandTabs("a\tb\nc\td")).toBe("a   b\nc   d");
  });
});