// Make an open prompt noticeable from outside the window.
//
// The owner's report on 2026-09-29: an approval prompt for edit_file sat
// untouched for about seven minutes. The console looked idle — "thinking #28
// 458s" — and the conclusion was that Flint had hung. It had not; it was
// waiting, and the only visible sign of waiting was a line of text in a window
// nobody was looking at.
//
// Two channels, because they fail differently:
//
//   BEL (\x07)      Windows Terminal (and most terminals) flash the taskbar
//                   entry. A bell in a window you cannot see is the one signal
//                   that reaches you at all. Guarded on isTTY: in a pipe or a
//                   log file, \x07 is a stray control character, not an alert,
//                   and it is worse than nothing — it corrupts captured output.
//   window title    "[!] Flint needs you", restored when answered. Survives
//                   scrollback, is visible from Alt+Tab, and works in hosts
//                   that swallow the bell.
//
// Both are started and stopped as a pair, and stop() is idempotent, because the
// call sites are a promise boundary: the prompt can be answered, timed out, or
// abandoned by a reset, and a title left saying "needs you" after the question
// is gone is worse than never having set it — it trains the operator to ignore
// the one word that should have been trusted.

import process from "node:process";

const BELL = "\x07";

/**
 * The title shown while a prompt is open.
 *
 * "Flint needs you" is the spec's wording and the title bar has room for it.
 * "waiting for approval" is added because a title has to work as a scan target:
 * read out of context from an Alt+Tab list, "needs you" is a sentence that
 * could mean anything, and "waiting for approval" cannot be mistaken for
 * anything else. Both are in it so neither reading is lost.
 */
export const ATTENTION_TITLE = "[!] Flint needs you — waiting for approval";

/**
 * Note that a prompt is open.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.isTTY] — defaults to this process's stdout
 * @param {string}  [opts.previousTitle] — the title to restore; read from the
 *   terminal if not given
 * @param {(title: string) => void} [opts.setTitle] — injectable so this is
 *   testable without a terminal; defaults to writing the OSC 0 sequence
 * @param {(char: string) => void} [opts.write] — injectable, same reason
 * @returns {{active: boolean, rings: boolean, previousTitle: string|null}}
 */
export function promptAttentionStart({
  isTTY = Boolean(process.stdout?.isTTY),
  previousTitle,
  setTitle = defaultSetTitle,
  write = defaultWrite,
} = {}) {
  const previous = previousTitle ?? readTitle();

  // Ring first. The title change alone is easy to absorb without noticing, and
  // this call is the one that reaches a window that is not in front.
  let rings = false;
  if (isTTY) {
    try {
      write(BELL);
      rings = true;
    } catch {
      // A terminal that cannot take the bell is not a reason to skip the title.
      rings = false;
    }
  }

  try {
    setTitle(ATTENTION_TITLE);
  } catch {}

  return { active: true, rings, previousTitle: previous, setTitle };
}

/**
 * The prompt is answered (or gone). Put the window back the way it was.
 *
 * Idempotent, and safe to call with nothing — the call sites race the timeout
 * against the answer, and "stop an attention signal that is not running" has to
 * be a no-op rather than a second restore.
 *
 * The `setTitle` used to restore comes from the state returned by start, not
 * from a second argument. An earlier version took it as an argument, which meant
 * a caller that had injected one (every test, and any host embedding the TUI)
 * had to pass it twice, and the ones that did not got the real terminal instead
 * of the one they were watching. The title was then set on the injected sink
 * and restored on the real terminal: the test saw the title never change, and
 * the operator's actual window was left reading "[!] Flint needs you" after the
 * question was answered. A leaked "[!]" is worse than no signal at all.
 *
 * @returns {boolean} whether anything was actually restored
 */
export function promptAttentionStop(state, { setTitle } = {}) {
  if (!state || !state.active) return false;
  state.active = false;
  const restore = state.setTitle || setTitle || defaultSetTitle;
  try {
    restore(state.previousTitle ?? "");
  } catch {}
  return true;
}

function defaultWrite(str) {
  process.stdout.write(str);
}

/** Read the current title from the terminal, when the host tracks one. */
function readTitle() {
  return process.stdout?.title ?? null;
}

/**
 * Set the terminal/window title.
 *
 * OSC 0 sets both the icon name and the window title, which is the one Windows
 * Terminal puts in the taskbar entry — the place the signal has to land.
 * process.stdout.title is tried first because on Windows it goes through the
 * console API, and a terminal that supports it does the taskbar flash for us.
 */
export function defaultSetTitle(title) {
  if (process.stdout && "title" in process.stdout) {
    process.stdout.title = title;
    return;
  }
  if (process.stdout?.isTTY) {
    process.stdout.write(`\x1b]0;${title}\x07`);
  }
}
