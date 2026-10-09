// Window title: the one place Flint is visible when the window is not in front.
//
// Backlog item 18, owner 2026-09-29 19:02: mid-build the console window title
// just said "bash", so from another window, from the taskbar or an Alt+Tab list
// there was no sign of anything running. The owner had to switch back to find
// out whether Flint had died. The item asks for a spinner in the window title
// while Flint works, so the entry you can see without focusing the window
// carries the signal.
//
// The same reasoning as the attention bell in prompt-attention.js, extended from
// "Flint needs you" to "Flint is working". This is the module that owns the
// spinner; prompt-attention.js still owns the urgent case and reaches for it
// through hold()/release() so a spinner cannot overwrite a prompt, and so the
// turn-end cost line at the end of a turn is not wiped by the next tick.

import { defaultSetTitle } from "./prompt-attention.js";
import { fitWidth } from "./title-width.js";

/**
 * Spinner frames: a gear and a spark, alternating (owner, 2026-10-02). The
 * title bar is drawn in the system UI font, which has both; the console keeps
 * braille dots, because several monospace fonts lack these two. The classic
 * "|/-\" set reads as a blinking cursor at title-bar size, which looks like a
 * crash. Do not replace these frames: they are the owner's choice. The title
 * has a fixed character count (title-width.js) so its width stays steady.
 */
export const TITLE_FRAMES = ["⛭", "✲"];

/**
 * How often the title changes.
 *
 * The owner ruled out 200ms explicitly ("not every 200ms; something a person can
 * read at a glance"). Faster than roughly a third of a second and the frames are
 * indistinguishable, so the title bar flickers instead of animating — and a
 * flicker in a peripheral position reads as noise rather than life. 500ms is
 * two slow frames a second: readable, and still obviously moving.
 */
export const TITLE_INTERVAL_MS = 500;

/** Shown when Flint is up and nothing is happening. */
export const IDLE_TITLE = "Flint";

/**
 * Write the title to the terminal.
 *
 * Delegated to prompt-attention's defaultSetTitle rather than reimplemented, so
 * there is exactly one place in Flint that knows how to set a window title. That
 * function already prefers process.stdout.title where it exists — which on
 * Windows is what makes the taskbar entry flash — and falls back to the OSC 0
 * escape on POSIX terminals. A second OSC writer here would have been a second
 * platform-specific guess at the same thing, and the two would disagree on
 * Windows.
 */
export function writeTitle(title, stream = process.stdout) {
  if (stream === process.stdout) {
    defaultSetTitle(title);
    return;
  }
  stream.write(`\x1b]0;${title}\x07`);
}

/**
 * Start animating the window title.
 *
 * @param {object} [opts]
 * @param {(title: string) => void} [opts.setTitle] injected for tests
 * @param {boolean} [opts.isTTY] injected for tests; real runs read the stream
 * @returns {{isRunning: boolean, hold: (t: string) => void, release: () => void, stop: () => void}}
 */
export function startAliveTitle({ setTitle = writeTitle, isTTY = process.stdout.isTTY } = {}) {
  let frame = 0;
  let timer = null;
  let held = null;

  // Not a terminal means no title: in a pipe, a log file or a test, an OSC 0
  // sequence is a stray control character in captured output, which is worse
  // than no title at all. Same guard the bell uses.
  let running = isTTY !== false && typeof setTitle === "function";

  const write = (title) => {
    if (!running) return;
    try {
      setTitle(title);
    } catch {
      // A window title is decoration. A terminal that rejects the sequence, or a
      // sink that throws, must not take the agent loop down with it — and the
      // animation keeps trying, because the condition may be momentary.
    }
  };

  let task = "";
  // Fixed-width: frame, name, then the current task cut or padded to a set size.
  const current = () => fitWidth(`${TITLE_FRAMES[frame]} Flint agent - ${task || "working"}`);

  const tick = () => {
    if (held !== null) return;
    frame = (frame + 1) % TITLE_FRAMES.length;
    write(current());
  };

  const begin = () => {
    if (timer) return;
    timer = setInterval(tick, TITLE_INTERVAL_MS);
    timer.unref?.();
  };

  if (running) {
    // Set something immediately: an Alt+Tab entry that is only correct after
    // half a second is an entry that is briefly still wrong.
    write(current());
    begin();
  }

  return {
    get isRunning() {
      return running;
    },

    /**
     * Show a title the operator has to read instead of the spinner, until
     * release(). An approval prompt, or the cost line at the end of a turn.
     */
    hold(title) {
      held = typeof title === "string" ? title : null;
      if (held !== null) write(held = fitWidth(held));
    },

    /** What Flint is doing now (first words of the request, or a tool name). */
    setTask(text) {
      task = typeof text === "string" ? text.trim().replace(/\s+/g, " ") : "";
    },

    /** Give the held title back to the animation. */
    release() {
      if (held === null) return;
      held = null;
      if (!running) return;
      write(current());
      begin();
    },

    /**
     * Stop animating, leaving a title that does not claim to be busy. A stopped
     * Flint that keeps spinning looks like a hung one.
     */
    stop() {
      if (!running) return;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      // Written while `running` is still true, because write() refuses to emit
      // once it is false. A stop that leaves the spinner in the title bar is a
      // stopped Flint that still looks busy — which is what this is avoiding.
      write(held !== null ? held : fitWidth(IDLE_TITLE));
      running = false;
    },
  };
}