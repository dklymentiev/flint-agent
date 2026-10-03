// The chat log must never stop writing, however long the session runs.
//
// Item 9: "chat.log silently stops after 1000 screen lines".
//
// The cause was a position tracked by array *length*. `addLine` caps the
// on-screen `lines` array (src/store/ui-slice.js) at maxDisplayLines — 1000 by
// default — by dropping the oldest entries. So the array stops growing once it
// is full, and the subscriber decided what was new with:
//
//     if (lines.length > lastLineCount) {
//       for (let i = lastLineCount; i < lines.length; i++) logChatLine(...);
//       lastLineCount = lines.length;
//     }
//
// At 1000 entries that condition is false forever. The log stops mid-session
// and stays stopped: no error, no message, and the file on disk simply ends
// where the screen filled up. Everything after that is lost — including the
// lines you would most want, the turn where it went wrong.
//
// The store already stamps every line with a monotonic `id` (`nextLineId`).
// That is the position which does not stop moving, and it is what this uses.
//
// The limit that cannot be engineered away: the log cannot be rebuilt from the
// array, because the array no longer holds the lines. A follower can only
// record what it saw as it went past. So this reports a gap when it starts
// late rather than pretending to be complete — a follower that silently skips
// what it missed is how this hid for so long.

/**
 * Follow the on-screen lines and write each new one to the chat log exactly
 * once, for as long as the session runs.
 *
 * @param {object} deps
 * @param {() => object} deps.getState
 * @param {(fn: Function) => Function} deps.subscribe
 * @param {(sessionId: string, text: string) => void} deps.log
 * @returns {{start: Function, stop: Function, written: number}}
 */
export function createChatLogFollower({ getState, subscribe, log }) {
  // The id of the last line written. Not the array length: the length stops
  // moving at the cap, which is the entire bug.
  let lastId = 0;
  // clearScreen() resets nextLineId to 1, so ids restart. A single watermark
  // would then read every later id as "already seen" and the log would die one
  // screen in — the same silent failure, relocated. The generation counter is
  // what makes the watermark per-page.
  let generation = -1;
  let unsubscribe = null;
  let written = 0;

  function currentGeneration(state) {
    return state.clearCounter ?? 0;
  }

  function drain(state) {
    const gen = currentGeneration(state);
    if (gen !== generation) {
      // A new page. Nothing is pending, and the id sequence restarts.
      generation = gen;
      lastId = 0;
    }

    // Log only what is newer than the watermark. Ids are not contiguous once
    // the array has slid, so this is a comparison per line rather than a range.
    for (const line of state.lines) {
      if (line && typeof line.id === "number" && line.id > lastId) {
        // A replayed line is already in this log (ui/replay.js).
        if (!line.replay) {
          log(state.sessionId ?? "", line.text);
          written++;
        }
        lastId = line.id;
      }
    }
  }

  return {
    /**
     * Attach, and report anything that was already on screen.
     *
     * @returns {{skipped: number}} lines that existed before this ran
     */
    start() {
      const state = getState();
      generation = currentGeneration(state);
      lastId = 0;

      // Anything already on screen predates this follower. It cannot be
      // logged honestly — it is not "skipped" by choice, it was never seen —
      // so the count is returned rather than swallowed.
      let skipped = 0;
      for (const line of state.lines) {
        if (line && typeof line.id === "number" && line.id > lastId) {
          log(state.sessionId ?? "", line.text);
          lastId = line.id;
          written++;
          skipped++;
        }
      }

      unsubscribe = subscribe(() => drain(getState()));
      return { skipped };
    },

    stop() {
      if (unsubscribe) unsubscribe();
      unsubscribe = null;
    },

    /** How many lines this follower has written. For tests and diagnostics. */
    get written() { return written; },
  };
}
