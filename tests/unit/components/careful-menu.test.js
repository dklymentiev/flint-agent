// The first-run question is a choice, not a wall of text.
//
// Owner, 2026-09-30: the first-run prompt read
//
//   How careful should Flint be?
//   [s]afe  (asks before every change to files and every command)   [n]ormal ...
//     — pick s, n or p
//
// He did not understand at first what it was. This test drives the rendered
// component with real keystrokes through ink-testing-library, the way
// tests/unit/components/app-tab-key.test.js does — it presses the keys and
// reads the frames it draws. Nothing here reads the source, because the last
// two UI bugs here (Tab calling a function that does not exist, item 7; the
// activity panel outliving its turn, item 11) both shipped behind tests that
// only read source text.

import { describe, it, expect, vi } from "vitest";

// Colour has to be asserted, and chalk drops every escape when stdout is not a
// TTY — which it never is under vitest. Without this the "is in colour" test
// would pass or fail on the terminal it happened to run in, and pass for the
// wrong reason here. vi.hoisted runs before the imports below are evaluated,
// which is the only moment FORCE_COLOR is still read.
vi.hoisted(() => {
  process.env.FORCE_COLOR = "3";
});

import React from "react";
import { render } from "ink-testing-library";

vi.mock("../../../src/logging/logger.js", () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}));

const h = React.createElement;
const tick = () => new Promise((r) => setTimeout(r, 50));

/** Load the component fresh so each test gets a clean module state. */
async function loadMenu() {
  return import("../../../src/components/CarefulMenu.js");
}

/** Render the menu, wiring onSelect the way the bootstrap does. */
async function renderMenu(onSelect, props = {}) {
  const { CarefulMenu } = await loadMenu();
  const instance = render(h(CarefulMenu, { onSelect, ...props }));
  await tick();
  return instance;
}

/**
 * The frame the menu actually drew.
 *
 * `lastFrame` hangs off the object render() returns, not off the fake stdin:
 * writing to stdin is how keystrokes go in, frames come back on stdout. Reading
 * it from stdin is how the first draft of this file passed five tests and
 * failed six for the wrong reason.
 */
function lastFrameOf(instance) {
  return instance.lastFrame() ?? "";
}

/** Strip ANSI so text assertions are about words, not escape codes. */
function plain(frame) {
  // eslint-disable-next-line no-control-regex
  return frame.replace(/\x1b\[[0-9;]*m/g, "");
}

function hasAnsi(frame) {
  // eslint-disable-next-line no-control-regex
  return /\x1b\[/.test(frame);
}

describe("CarefulMenu: it looks like a choice", () => {
  it("offers all three levels, one per line, each with a plain sentence", async () => {
    const { stdin, unmount, lastFrame } = await renderMenu(() => {});
    try {
      const text = plain(lastFrame());
      for (const level of ["safe", "normal", "permissive"]) {
        expect(text, `the menu does not offer "${level}"`).toContain(level);
      }
      // One per line, not the three-of-them-on-one-line wall the owner saw.
      // The marker is allowed in front: the highlighted option draws as
      // "❯ normal", so an anchored match on the bare word counts two lines
      // out of three and fails against a menu that is drawn correctly.
      const lines = text.split("\n").map((l) => l.trim());
      const optionLines = lines.filter((l) => /^[>❯]?\s*(safe|normal|permissive)\b/.test(l));
      expect(optionLines.length, `expected 3 option lines, got:\n${text}`).toBe(3);
      // And each one explains itself in a sentence, rather than three names
      // with no consequence attached.
      for (const line of optionLines) {
        expect(line.trim().split(/\s+/).length, `option line says nothing about what it means: "${line}"`)
          .toBeGreaterThan(3);
      }
    } finally {
      unmount();
    }
  });

  it("is in colour, because a choice has to read as a choice", async () => {
    const { stdin, unmount, lastFrame } = await renderMenu(() => {});
    try {
      const frame = lastFrame();
      expect(hasAnsi(frame), "the menu drew no colour at all").toBe(true);
      // The highlighted option carries its own escape codes, not just a marker.
      const highlighted = frame
        .split("\n")
        .filter((l) => /\x1b\[/.test(l) && /normal/.test(l));
      expect(highlighted.length, "the default option is not highlighted in colour").toBeGreaterThan(0);
    } finally {
      unmount();
    }
  });

  it("says what is being decided, that it is asked once, and how to change it", async () => {
    const { stdin, unmount, lastFrame } = await renderMenu(() => {});
    try {
      const text = plain(lastFrame()).toLowerCase();
      // What is decided — the owner did not know this was the question.
      expect(text).toMatch(/careful|permission|ask/);
      // Asked once, so a second launch does not repeat it.
      expect(text).toMatch(/once|only ever|first run|first time/);
      // And the escape hatch is named, not implied.
      expect(text).toMatch(/\/careful|change (it )?later|any time/);
    } finally {
      unmount();
    }
  });
});

describe("CarefulMenu: the default is marked and highlighted", () => {
  it("starts with the default selected and says which one it is", async () => {
    const { stdin, unmount, lastFrame } = await renderMenu(() => {});
    try {
      const frame = lastFrame();
      const text = plain(frame);
      const cursorLine = text
        .split("\n")
        .find((l) => /[>❯]/.test(l));
      expect(cursorLine, "no cursor marks the current choice").toBeDefined();
      expect(cursorLine.toLowerCase(), "the cursor is not on the default (normal)").toContain("normal");
      expect(text.toLowerCase(), "the default is not marked as the default").toMatch(/default/);
    } finally {
      unmount();
    }
  });

  it("moves the highlight with the arrow keys", async () => {
    const { stdin, unmount, lastFrame } = await renderMenu(() => {});
    try {
      await tick();
      stdin.write("\x1B[B"); // down
      await tick();
      const text = plain(lastFrame());
      const cursorLine = text.split("\n").find((l) => /[>❯]/.test(l));
      expect(cursorLine, "the cursor is gone after arrow-down").toBeDefined();
      expect(
        cursorLine.toLowerCase(),
        "arrow-down did not move off the default to the next option",
      ).not.toContain("normal");
      stdin.write("\x1B[A"); // up
      await tick();
      const back = plain(lastFrame()).split("\n").find((l) => /[>❯]/.test(l));
      expect(back.toLowerCase(), "arrow-up did not return to the default").toContain("normal");
    } finally {
      unmount();
    }
  });
});

describe("CarefulMenu: choosing with Enter or with a letter", () => {
  it("Enter picks the option under the cursor", async () => {
    const chosen = [];
    const { stdin, unmount, lastFrame } = await renderMenu((level) => chosen.push(level));
    try {
      expect(chosen, "Enter before any key must not answer").toHaveLength(0);
      stdin.write("\r");
      await tick();
      expect(chosen, "Enter did not choose the highlighted default").toEqual(["normal"]);
    } finally {
      unmount();
    }
  });

  it("Enter after arrow-down picks the moved-to option", async () => {
    const chosen = [];
    const { stdin, unmount, lastFrame } = await renderMenu((level) => chosen.push(level));
    try {
      stdin.write("\x1B[B");
      await tick();
      stdin.write("\r");
      await tick();
      expect(chosen).toEqual(["permissive"]);
    } finally {
      unmount();
    }
  });

  it("a letter still works, so the earlier fix is not thrown away", async () => {
    for (const [key, level] of [["s", "safe"], ["n", "normal"], ["p", "permissive"]]) {
      const chosen = [];
      const { stdin, unmount, lastFrame } = await renderMenu((l) => chosen.push(l));
      try {
        stdin.write(key);
        await tick();
        expect(chosen, `pressing "${key}" did not choose ${level}`).toEqual([level]);
      } finally {
        unmount();
      }
    }
  });

  it("answers once only, so a held key cannot record two postures", async () => {
    const chosen = [];
    const { stdin, unmount, lastFrame } = await renderMenu((l) => chosen.push(l));
    try {
      stdin.write("s");
      await tick();
      stdin.write("p");
      await tick();
      expect(chosen, "the menu answered twice").toHaveLength(1);
    } finally {
      unmount();
    }
  });

  // The tests above wait 50 ms between keys. In 50 ms ink has both re-rendered
  // the menu and re-registered its useInput handler with a fresh closure, so
  // they stayed green when f9edc9c (read the index from a ref) was reverted.
  // The defect that commit fixed lives in a narrower window: the arrow key has
  // been rendered, but the effect that swaps the handler has not run yet. One
  // turn of the timer queue lands there: React commits the render from a
  // setImmediate, the timer fires next, the effect comes after it.
  // Measured 2026-10-08: with the fix green on every run, with the handler
  // reading the `index` state again red on every run.
  const afterRenderBeforeEffect = () => new Promise((r) => setTimeout(r, 0));

  it("Enter right behind arrow-down picks the moved-to option, not the one before it", async () => {
    const chosen = [];
    const { stdin, unmount } = await renderMenu((level) => chosen.push(level));
    try {
      stdin.write("\x1B[B");
      await afterRenderBeforeEffect();
      stdin.write("\r");
      await tick();
      expect(chosen, "Enter used the index from before the arrow key").toEqual(["permissive"]);
    } finally {
      unmount();
    }
  });

  it("Enter right behind arrow-up picks the moved-to option, not the one before it", async () => {
    const chosen = [];
    const { stdin, unmount } = await renderMenu((level) => chosen.push(level));
    try {
      stdin.write("\x1B[A");
      await afterRenderBeforeEffect();
      stdin.write("\r");
      await tick();
      expect(chosen, "Enter used the index from before the arrow key").toEqual(["safe"]);
    } finally {
      unmount();
    }
  });

  // KNOWN DEFECTS, not guarded behaviour. `it.fails` is green while the defect
  // is there and turns red the day it is fixed: then change it to `it`.
  //
  // The ref from f9edc9c is written during render, so it is only as fresh as
  // the last render. Two keys in one turn of the event loop (a paste, a key
  // repeat, one stdin chunk holding both) have no render between them, and the
  // second key still reads the old index. `done` is worse: it is plain state
  // read from the closure, so the "answer once" latch is open until the
  // handler is re-registered, which is after the render AND the effect.
  // Both need a ref that the handler itself writes, not one mirrored in render.
  it.fails("DEFECT: arrow-down and Enter in the same tick pick the old option", async () => {
    const chosen = [];
    const { stdin, unmount } = await renderMenu((level) => chosen.push(level));
    try {
      stdin.write("\x1B[B");
      stdin.write("\r");
      await tick();
      expect(chosen).toEqual(["permissive"]);
    } finally {
      unmount();
    }
  });

  it.fails("DEFECT: two answers in the same tick record two postures", async () => {
    const chosen = [];
    const { stdin, unmount } = await renderMenu((l) => chosen.push(l));
    try {
      stdin.write("s");
      stdin.write("p");
      await tick();
      expect(chosen).toEqual(["safe"]);
    } finally {
      unmount();
    }
  });

  it.fails("DEFECT: a second answer right behind the first, already rendered, is still recorded", async () => {
    const chosen = [];
    const { stdin, unmount } = await renderMenu((l) => chosen.push(l));
    try {
      stdin.write("s");
      await afterRenderBeforeEffect();
      stdin.write("p");
      await tick();
      expect(chosen).toEqual(["safe"]);
    } finally {
      unmount();
    }
  });

  it("Esc declines rather than choosing — a cancelled question is not an answer", async () => {
    const chosen = [];
    let cancelled = false;
    const { CarefulMenu } = await loadMenu();
    const instance = render(
      h(CarefulMenu, { onSelect: (l) => chosen.push(l), onCancel: () => { cancelled = true; } }),
    );
    try {
      await tick();
      instance.stdin.write("\x1B");
      await tick();
      expect(chosen, "Esc chose a level").toHaveLength(0);
      expect(cancelled, "Esc did not report a cancellation").toBe(true);
    } finally {
      instance.unmount();
    }
  });

  it("junk keys are ignored instead of choosing something nobody picked", async () => {
    const chosen = [];
    const { stdin, unmount, lastFrame } = await renderMenu((l) => chosen.push(l));
    try {
      for (const junk of ["x", "z", "9"]) {
        stdin.write(junk);
        await tick();
      }
      expect(chosen, "an unrecognised key chose a level").toHaveLength(0);
    } finally {
      unmount();
    }
  });
});