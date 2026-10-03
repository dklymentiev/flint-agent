// Pasted text stands in the input as a token; a few of its lines are shown
// above the input and in the history; the model gets the full text
// (owner, 2026-10-01).
import { describe, it, expect, vi } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import {
  applyInsert, expandPastes, pasteToken, imageIds, isPasteChunk, PASTE_MERGE_MS,
  previewPastes, composeRows, previewLines,
} from "../../../src/ui/paste-tokens.js";

vi.mock("../../../src/logging/logger.js", () => ({
  createLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
}));

const fresh = () => ({ pastes: new Map(), state: { nextId: 1, last: null } });
const BIG = Array.from({ length: 18 }, (_, i) => `line ${i + 1}`).join("\n");

describe("applyInsert", () => {
  const at = (value, cursor = value.length) => ({ value, cursor });
  it("inserts typing at the cursor", () => {
    const { pastes, state } = fresh();
    expect(applyInsert({ ...at("helo", 3), chunk: "l", pastes, state })).toEqual({ value: "hello", cursor: 4 });
    expect(pastes.size).toBe(0);
  });

  it("turns a multi-line insert into a token, at the cursor", () => {
    const { pastes, state } = fresh();
    const out = applyInsert({ ...at("look at this:  please", 14), chunk: BIG, pastes, state });
    expect(out.value).toBe("look at this: [Pasted text #1 · 18 lines] please");
    expect(out.cursor).toBe("look at this: [Pasted text #1 · 18 lines]".length);
    expect(pastes.get(1)).toBe(BIG);
  });

  it("turns a long single-line insert into a token", () => {
    const { pastes, state } = fresh();
    expect(applyInsert({ ...at(""), chunk: "x".repeat(300), pastes, state }).value).toBe("[Pasted text #1 · 300 chars]");
  });

  it("merges the chunks of one paste that arrive close together", () => {
    const { pastes, state } = fresh();
    let s = applyInsert({ ...at(""), chunk: "a\nb\nc\nd\n", pastes, state, now: 1000 });
    s = applyInsert({ ...s, chunk: "e\nf", pastes, state, now: 1000 + PASTE_MERGE_MS - 1 });
    expect(s.value).toBe("[Pasted text #1 · 6 lines]");
    expect(pastes.get(1)).toBe("a\nb\nc\nd\ne\nf");
  });

  it("starts a new token for a paste made later", () => {
    const { pastes, state } = fresh();
    let s = applyInsert({ ...at(""), chunk: "a\nb\nc\nd", pastes, state, now: 1000 });
    s = applyInsert({ ...s, chunk: " and ", pastes, state, now: 5000 });
    s = applyInsert({ ...s, chunk: "e\nf\ng\nh", pastes, state, now: 9000 });
    expect(s.value).toBe("[Pasted text #1 · 4 lines] and [Pasted text #2 · 4 lines]");
  });

  it("expands a paste that starts with brackets exactly", () => {
    const { pastes, state } = fresh();
    const s = applyInsert({ ...at(""), chunk: "[x]\n[y]\n[z]\n[w]", pastes, state });
    expect(expandPastes(s.value, pastes)).toBe("[x]\n[y]\n[z]\n[w]");
  });
});

describe("showing a paste", () => {
  const pastes = new Map([[6, BIG]]);
  it("shows three lines and how many more", () => {
    expect(previewLines(BIG)).toEqual({ shown: ["line 1", "line 2", "line 3"], more: 15 });
  });
  it("opens the token in the history line into its first lines", () => {
    expect(previewPastes("explain: [Pasted text #6 · 18 lines]", pastes))
      .toBe("explain: \n  line 1\n  line 2\n  line 3\n  … +15 more lines");
  });
  it("draws a small block above the input while composing", () => {
    expect(composeRows("explain: [Pasted text #6 · 18 lines]", pastes))
      .toEqual(["┌ pasted #6", "│ line 1", "│ line 2", "│ line 3", "└ +15 more lines"]);
  });
  it("shows at most two pasted blocks above the input", () => {
    const many = new Map([[1, "a\nb\nc\nd"], [2, "e\nf\ng\nh"], [3, "i\nj\nk\nl"]]);
    const rows = composeRows("[Pasted text #1 · 4 lines] [Pasted text #2 · 4 lines] [Pasted text #3 · 4 lines]", many);
    expect(rows.filter((r) => r.startsWith("┌"))).toHaveLength(2);
    expect(rows[rows.length - 1]).toContain("more pasted text");
  });
});

describe("expandPastes and imageIds", () => {
  it("puts the full text back, leaving unknown tokens as they are", () => {
    const pastes = new Map([[1, BIG]]);
    expect(expandPastes(`see ${pasteToken(1, BIG)} and [Pasted text #9 · 2 lines]`, pastes))
      .toBe(`see ${BIG} and [Pasted text #9 · 2 lines]`);
  });
  it("lists image numbers once each", () => {
    expect(imageIds("[Image #2] vs [Image #1] and [Image #2]")).toEqual([2, 1]);
  });
  it("leaves short pastes inline; four lines or 300 characters become a token", () => {
    expect(isPasteChunk("hello")).toBe(false);
    expect(isPasteChunk("a\nb\nc")).toBe(false);
    expect(isPasteChunk("a\nb\nc\nd")).toBe(true);
    expect(isPasteChunk("x".repeat(300))).toBe(true);
  });
});

describe("App with a paste", () => {
  it("shows the token and a preview, sends the full text, recalls the token", async () => {
    const { App } = await import("../../../src/components/App.js");
    const { createMockStore } = await import("../../helpers/mock-store.js");
    const onSubmit = vi.fn();
    const { stdin, lastFrame, unmount } = render(React.createElement(App, { store: createMockStore(), onSubmit, onAbort() {}, onQuit() {} }));
    const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));
    await tick();
    stdin.write("explain: ");
    await tick();
    stdin.write(BIG);
    await tick();
    const frame = lastFrame();
    expect(frame).toContain("[Pasted text #1 · 18 lines]");
    expect(frame).toContain("│ line 3");
    expect(frame).toContain("└ +15 more lines");
    expect(frame).not.toContain("line 17");
    stdin.write("\r");
    await tick();
    expect(onSubmit).toHaveBeenCalledWith(`explain: ${BIG}`, expect.objectContaining({
      display: "explain: \n  line 1\n  line 2\n  line 3\n  … +15 more lines",
      history: "explain: [Pasted text #1 · 18 lines]",
    }));
    unmount();
  });
});
