// The window title should show that Flint is alive.
//
// Backlog item 18, owner 2026-09-29 19:02: Flint was mid-build and the console
// window title just said "bash", so from another window, from the taskbar, or
// from an Alt+Tab list there was no sign of anything running. The owner had to
// switch back to find out whether it had died. The proposal in the item is a
// spinner in the window title while Flint works, so the entry that is visible
// when the window is NOT in front carries the signal.
//
// Driven behaviour, not source text: fake timers advance the interval and the
// sink records every title actually written, which is what a taskbar entry
// would show. The interval is asserted as a number because the item is
// specific about it — "not every 200ms; something a person can read at a
// glance" — and 200ms is exactly the blur the owner ruled out, so a test that
// only checked that the title changed would pass on the rejected design.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../../src/logging/logger.js", () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}));

async function load() {
  return import("../../../src/ui/window-title.js");
}

/** The titles the terminal was actually told to show, in order. */
function sink() {
  const written = [];
  return { written, setTitle: (t) => written.push(t) };
}

describe("window title: Flint is visibly alive", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("puts a spinner in the title and advances it while Flint works", async () => {
    const { startAliveTitle } = await load();
    const { written, setTitle } = sink();

    const title = startAliveTitle({ setTitle, isTTY: true });
    try {
      // Something is on screen before any time passes: an Alt+Tab entry that is
      // only correct after 500ms is an entry that is briefly still wrong.
      expect(written.length, "no title was set when the work started").toBe(1);

      const first = written[0];
      expect(first, "the title does not say Flint is alive").toMatch(/Flint/);

      vi.advanceTimersByTime(500);
      expect(written.length, "the title never advanced").toBeGreaterThan(1);
      expect(
        written[1],
        "the title advanced but the spinner frame did not change",
      ).not.toBe(first);

      vi.advanceTimersByTime(500);
      expect(written[2], "the title stopped advancing").not.toBe(written[1]);
    } finally {
      title.stop();
    }
  });

  it("is slow enough for a person to read, not a 200ms blur", async () => {
    const { TITLE_INTERVAL_MS, startAliveTitle } = await load();

    // The owner ruled out 200ms explicitly. Faster than ~350ms and the frames
    // are indistinguishable, so the title bar flickers instead of animating,
    // and a flicker in a peripheral position reads as noise rather than life.
    expect(
      TITLE_INTERVAL_MS,
      `the title animates every ${TITLE_INTERVAL_MS}ms, which is the blur the owner rejected`,
    ).toBeGreaterThanOrEqual(350);

    // And it really is that slow: 200ms must not produce a new title.
    const { written, setTitle } = sink();
    const title = startAliveTitle({ setTitle, isTTY: true });
    try {
      const at200 = written.length;
      vi.advanceTimersByTime(200);
      expect(
        written.length,
        "a title was rewritten within 200ms, which is faster than the item allows",
      ).toBe(at200);
      vi.advanceTimersByTime(TITLE_INTERVAL_MS);
      expect(written.length, "the title never advanced").toBeGreaterThan(at200);
    } finally {
      title.stop();
    }
  });

  it("shows more than one spinner frame, so movement is visible", async () => {
    const { TITLE_FRAMES } = await load();
    // Two frames alternating (a gear and a spark, owner 2026-10-02) are
    // movement; one frame is a static mark.
    expect(TITLE_FRAMES.length, "one frame is a static mark, not an animation").toBeGreaterThan(1);
    expect(new Set(TITLE_FRAMES).size, "the spinner frames repeat").toBe(TITLE_FRAMES.length);
  });

  it("stops cleanly: no more titles, and one final one left behind", async () => {
    const { startAliveTitle } = await load();
    const { written, setTitle } = sink();

    const title = startAliveTitle({ setTitle, isTTY: true });
    vi.advanceTimersByTime(1500);
    title.stop();

    const atStop = written.length;
    vi.advanceTimersByTime(5000);
    expect(
      written.length - atStop,
      "the timer kept running after stop(), so a finished Flint kept animating",
    ).toBe(0);

    // Leave something behind that says the work is done rather than mid-spinner.
    expect(
      written[written.length - 1],
      "the last title still shows the spinner, so a stopped Flint looks busy",
    ).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
  });

  it("can be stopped twice, because the call sites race", async () => {
    const { startAliveTitle } = await load();
    const { setTitle } = sink();

    const title = startAliveTitle({ setTitle, isTTY: true });
    title.stop();
    const afterFirst = title.isRunning;
    expect(() => title.stop()).not.toThrow();
    expect(title.isRunning, "a second stop() restarted the animation").toBe(afterFirst);
  });

  it("writes nothing at all when stdout is not a terminal", async () => {
    const { startAliveTitle } = await load();
    const { written, setTitle } = sink();

    // In a pipe, a log file or a test, an OSC 0 sequence is a stray control
    // character in captured output — worse than no title at all. Same guard the
    // bell uses in prompt-attention.js.
    const title = startAliveTitle({ setTitle, isTTY: false });
    try {
      vi.advanceTimersByTime(2000);
      expect(written, "a title was written into a non-terminal stdout").toEqual([]);
    } finally {
      title.stop();
    }
  });

  it("survives a title sink that throws, because a window title is not worth a crash", async () => {
    const { startAliveTitle } = await load();
    let calls = 0;
    const title = startAliveTitle({
      isTTY: true,
      setTitle: () => {
        calls++;
        throw new Error("no terminal here");
      },
    });
    try {
      expect(() => vi.advanceTimersByTime(2000)).not.toThrow();
      expect(calls, "a throwing sink stopped the animation after one attempt").toBeGreaterThan(1);
    } finally {
      expect(() => title.stop()).not.toThrow();
    }
  });

  describe("a more urgent title can take over", () => {
    it("holds a title that outranks the spinner, then gives it back", async () => {
      const { startAliveTitle } = await load();
      const { written, setTitle } = sink();

      const title = startAliveTitle({ setTitle, isTTY: true });
      try {
        vi.advanceTimersByTime(500);

        // An approval prompt, or a turn-end cost line: something that must be
        // read, so the spinner must not overwrite it on the next tick.
        title.hold("[!] Flint needs you");
        const atHold = written.length;

        vi.advanceTimersByTime(3000);
        expect(
          written.length,
          "the spinner overwrote a title the operator has to read",
        ).toBe(atHold);

        title.release();
        vi.advanceTimersByTime(500);
        expect(written.length, "the animation did not come back").toBeGreaterThan(atHold);
        expect(title.isRunning, "release() did not resume the animation").toBe(true);
      } finally {
        title.stop();
      }
    });

    it("leaves the held title alone when stopped", async () => {
      const { startAliveTitle } = await load();
      const { written, setTitle } = sink();

      const title = startAliveTitle({ setTitle, isTTY: true });
      title.hold("Flint | $0.0123 | 4 tok");
      title.stop();

      expect(
        written[written.length - 1],
        "stop() replaced a held title, losing the cost line it was told to keep",
      ).toBe("Flint | $0.0123 | 4 tok");
    });

    it("takes the last hold when two overlap", async () => {
      const { startAliveTitle } = await load();
      const { written, setTitle } = sink();

      const title = startAliveTitle({ setTitle, isTTY: true });
      try {
        title.hold("first");
        title.hold("second");
        vi.advanceTimersByTime(2000);
        expect(
          written[written.length - 1],
          "the earlier hold won over a later one",
        ).toBe("second");
      } finally {
        title.stop();
      }
    });
  });
});