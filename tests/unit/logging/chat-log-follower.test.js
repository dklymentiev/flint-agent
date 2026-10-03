// The chat log must never stop writing, however long the session runs.
//
// Item 9: "chat.log silently stops after 1000 screen lines".
//
// The cause is a position tracked by array length. `addLine` caps the on-screen
// `lines` array (ui-slice.js) at 1000 by dropping the oldest entries, so the
// array stops growing once it is full. The chat.log subscriber decided what was
// new with:
//
//     if (lines.length > lastLineCount) {
//       for (let i = lastLineCount; i < lines.length; i++) logChatLine(...);
//       lastLineCount = lines.length;
//     }
//
// At 1000 entries the condition is false forever. The log stops mid-session
// and stays stopped — no error, no message, and the file on disk simply ends
// where the screen filled up. Everything after that point is lost, including
// the lines you would want most: the turn where it went wrong.
//
// The store already stamps every line with a monotonic `id` (nextLineId).
// That is the position that does not stop moving, and it is what this uses.
//
// One subtlety that the cap makes unavoidable: the log cannot be rebuilt from
// the array, because the array no longer holds the lines. So the subscriber
// must record what it has written as it goes — it cannot go back and recover.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createChatLogFollower } from "../../../src/logging/chat-log-follower.js";

/** A store stand-in that behaves like ui-slice's lines array: capped, ided. */
function makeStore(cap = 5) {
  let nextLineId = 1;
  let state = {
    lines: [],
    nextLineId,
    sessionId: "s1",
    clearCounter: 0,
  };
  const listeners = new Set();
  const emit = () => { for (const l of listeners) l(state); };

  return {
    getState: () => state,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    addLine(text) {
      const id = nextLineId++;
      // The cap: the oldest lines are dropped, so length stops growing.
      state = { ...state, nextLineId, lines: [...state.lines, { id, text }].slice(-cap) };
      emit();
    },
    clearScreen() {
      nextLineId = 1;
      state = { ...state, lines: [], nextLineId, clearCounter: state.clearCounter + 1 };
      emit();
    },
  };
}

describe("the chat log keeps writing past the screen cap", () => {
  let written, store, follower;

  beforeEach(() => {
    written = [];
    store = makeStore(5);
    follower = createChatLogFollower({
      getState: () => store.getState(),
      subscribe: (fn) => store.subscribe(fn),
      log: (sid, text) => written.push(text),
    });
    // The follower only watches the store once started. The first draft of
    // this file built it in beforeEach and never called start(), so it never
    // subscribed and every test saw an empty log — seven failures that all
    // looked like the fix not working.
    follower.start();
  });

  it("writes every line while under the cap", () => {
    for (let i = 0; i < 3; i++) store.addLine(`line ${i}`);
    expect(written).toEqual(["line 0", "line 1", "line 2"]);
  });

  it("keeps writing after the cap is reached", () => {
    // The bug. At the cap the array stops growing, a length-based follower
    // sees no change and stops permanently.
    for (let i = 0; i < 5; i++) store.addLine(`line ${i}`);
    written.length = 0; // only care about what happens past the cap
    store.addLine("past the cap");
    store.addLine("and another");
    expect(written).toEqual(["past the cap", "and another"]);
  });

  it("does not re-write lines that were already logged when the array slid", () => {
    for (let i = 0; i < 5; i++) store.addLine(`line ${i}`);
    written.length = 0;
    store.addLine("sixth");
    // The array has dropped `line 0` to make room. Re-logging everything still
    // in the array would duplicate four lines on every single add past the cap.
    expect(written).toEqual(["sixth"]);
  });

  it("survives a long session", () => {
    for (let i = 0; i < 50; i++) store.addLine(`line ${i}`);
    expect(written).toHaveLength(50);
    expect(written[0]).toBe("line 0");
    expect(written[49]).toBe("line 49");
  });

  it("logs the lines that matter most — the ones after a long run", () => {
    for (let i = 0; i < 40; i++) store.addLine(`chatter ${i}`);
    written.length = 0;
    store.addLine("[ERROR] the thing went wrong at last");
    expect(written).toEqual(["[ERROR] the thing went wrong at last"]);
  });
});

describe("clearing the screen does not corrupt the log", () => {
  it("starts a fresh page without logging the whole screen again", () => {
    const written = [];
    const store = makeStore(5);
    const follower = createChatLogFollower({
      getState: () => store.getState(),
      subscribe: (fn) => store.subscribe(fn),
      log: (sid, text) => written.push(text),
    });
    follower.start();

    store.addLine("before the clear");
    written.length = 0;
    store.clearScreen();
    // clearScreen resets nextLineId to 1, so ids restart. A follower that
    // only remembers "the highest id I saw" would then log nothing at all for
    // the rest of the session — the same silent death, one screen later.
    store.addLine("after the clear");
    expect(written).toEqual(["after the clear"]);
  });

  it("does not log the old screen a second time after a clear", () => {
    const written = [];
    const store = makeStore(5);
    const follower = createChatLogFollower({
      getState: () => store.getState(),
      subscribe: (fn) => store.subscribe(fn),
      log: (sid, text) => written.push(text),
    });
    follower.start();
    store.addLine("one");
    written.length = 0;
    store.clearScreen();
    store.addLine("two");
    store.addLine("three");
    expect(written).toEqual(["two", "three"]);
  });
});

describe("the follower is honest about what it can do", () => {
  it("cannot recover lines that were never seen, only ones still pending", () => {
    // The cap makes this a real limit, and it should be stated rather than
    // discovered: a line can only be logged if the follower was alive to see
    // it added. It cannot re-read a screen that has already slid past.
    const written = [];
    const store = makeStore(3);
    const follower = createChatLogFollower({
      getState: () => store.getState(),
      subscribe: (fn) => store.subscribe(fn),
      log: (sid, text) => written.push(text),
    });
    // Attached late: line 0 already exists and has slid out of the array.
    store.addLine("0");
    store.addLine("1");
    store.addLine("2");
    follower.start();
    written.length = 0;
    store.addLine("3");
    expect(written).toEqual(["3"]);
  });

  it("reports a gap rather than pretending to be complete", () => {
    // A follower that silently skips what it missed is how this bug hid for so
    // long. If it started late, it says so.
    const written = [];
    const store = makeStore(3);
    const follower = createChatLogFollower({
      getState: () => store.getState(),
      subscribe: (fn) => store.subscribe(fn),
      log: (sid, text) => written.push(text),
    });
    store.addLine("0");
    store.addLine("1");
    store.addLine("2");
    const gap = follower.start();
    expect(gap.skipped).toBe(3); // three lines existed before the follower did
  });
});
