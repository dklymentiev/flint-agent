// The input line edits at a cursor (owner, 2026-10-01: the cursor was stuck at
// the end; arrows, Ctrl+arrows, Home/End did nothing).
import { describe, it, expect, vi } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import {
  moveLeft, moveRight, wordLeft, wordRight, insertAt, backspace, deleteForward,
  deleteWordBack, wrapRows, cursorCell, tokenRanges,
} from "../../../src/ui/line-edit.js";

vi.mock("../../../src/logging/logger.js", () => ({
  createLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
}));

const s = (value, cursor = value.length) => ({ value, cursor });

describe("cursor movement", () => {
  it("moves by one character", () => {
    expect(moveLeft(s("abc", 2)).cursor).toBe(1);
    expect(moveRight(s("abc", 2)).cursor).toBe(3);
    expect(moveLeft(s("abc", 0)).cursor).toBe(0);
  });
  it("moves over an emoji as one character", () => {
    expect(moveLeft(s("a😀b", 3)).cursor).toBe(1);
    expect(moveRight(s("a😀b", 1)).cursor).toBe(3);
  });
  it("moves by word with Ctrl", () => {
    const v = "fix the  parser now";
    expect(wordLeft(s(v)).cursor).toBe(v.indexOf("now"));
    expect(wordLeft(s(v, v.indexOf("now"))).cursor).toBe(v.indexOf("parser"));
    expect(wordRight(s(v, 0)).cursor).toBe(3);
    expect(wordRight(s(v, 3)).cursor).toBe(7);
  });
  it("jumps over a paste token as one character", () => {
    const v = "see [Pasted text #1 · 4 lines] ok";
    const [start, end] = tokenRanges(v)[0];
    expect(moveLeft(s(v, end)).cursor).toBe(start);
    expect(moveRight(s(v, start)).cursor).toBe(end);
  });
});

describe("editing at the cursor", () => {
  it("inserts in the middle", () => {
    expect(insertAt(s("helo", 3), "l")).toEqual({ value: "hello", cursor: 4 });
  });
  it("Backspace and Delete remove one character, or a whole token", () => {
    expect(backspace(s("abc", 2))).toEqual({ value: "ac", cursor: 1 });
    expect(deleteForward(s("abc", 1))).toEqual({ value: "ac", cursor: 1 });
    const v = "x [Image #2] y";
    expect(backspace(s(v, "x [Image #2]".length))).toEqual({ value: "x  y", cursor: 2 });
    expect(deleteForward(s(v, 2))).toEqual({ value: "x  y", cursor: 2 });
  });
  it("Ctrl+W removes the word before the cursor", () => {
    expect(deleteWordBack(s("fix the parser", 7))).toEqual({ value: "fix  parser", cursor: 4 });
  });
});

describe("wrapping and the drawn cursor", () => {
  it("wraps by character, so the cursor cell is exact", () => {
    expect(wrapRows("abcdefgh", 3)).toEqual(["abc", "def", "gh"]);
    expect(cursorCell("abcdefgh", 4, 3)).toEqual({ row: 1, col: 1 });
    expect(cursorCell("abcdefgh", 8, 3)).toEqual({ row: 2, col: 2 });
  });
  it("counts Cyrillic one column per letter", () => {
    expect(cursorCell("привет", 3, 80)).toEqual({ row: 0, col: 3 });
  });
});

describe("LineInput in the App", () => {
  const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));
  async function mount() {
    const { App } = await import("../../../src/components/App.js");
    const { createMockStore } = await import("../../helpers/mock-store.js");
    const onSubmit = vi.fn();
    const r = render(React.createElement(App, { store: createMockStore(), onSubmit, onAbort() {}, onQuit() {} }));
    await tick();
    return { ...r, onSubmit };
  }

  it("types in the middle after moving left", async () => {
    const { stdin, onSubmit, unmount } = await mount();
    stdin.write("helo");
    await tick();
    stdin.write("\x1b[D"); // Left
    await tick();
    stdin.write("l");
    await tick();
    stdin.write("\r");
    await tick();
    expect(onSubmit.mock.calls[0][0]).toBe("hello");
    unmount();
  });

  it("Home goes to the start, Ctrl+Right jumps a word", async () => {
    const { stdin, onSubmit, unmount } = await mount();
    stdin.write("world peace");
    await tick();
    stdin.write("\x1b[H"); // Home
    await tick();
    stdin.write("hello ");
    await tick();
    stdin.write("\x1b[1;5C"); // Ctrl+Right: to the end of "world"
    await tick();
    stdin.write("!");
    await tick();
    stdin.write("\r");
    await tick();
    expect(onSubmit.mock.calls[0][0]).toBe("hello world! peace");
    unmount();
  });

  it("keeps every character of a fast burst", async () => {
    const { stdin, onSubmit, unmount } = await mount();
    for (const ch of "dictated words arrive fast") stdin.write(ch);
    await tick();
    stdin.write("\r");
    await tick();
    expect(onSubmit.mock.calls[0][0]).toBe("dictated words arrive fast");
    unmount();
  });
});
