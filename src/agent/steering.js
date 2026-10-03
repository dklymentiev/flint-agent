// Steering that applies to the NEXT completion only.
//
// Before this, twelve places in agent.js pushed a system message straight into
// the conversation array, and nothing ever took one out. The array is also the
// session and the source of the rolling context window, so every nudge became a
// standing instruction: it survived the turn that raised it, crossed into the
// next turn, and stacked with copies of itself.
//
// Measured on ten readiness probes, 2026-09-21, from the payloads in
// sessions/*.messages.jsonl:
//
//     [OUTCOME]   raised 8 times     sent to the model 202 times
//     [SAFETY]                       sent to the model 192 times
//     most system messages in one call                  20
//     most copies of one nudge in one call                3
//     leftover nudges present at the start of a turn      6
//
// What that did to answers: three standing orders to answer "in one
// sentence" and the answer collapses to one sentence.
//
// A nudge now lives in this slot instead. It is assembled into ONE system
// message appended to the payload of the next completion, and dropped. It never
// touches the conversation, so it cannot be saved, cannot be re-sent and cannot
// pile up.

/**
 * Order the nudges are read in, most urgent first. Not a filter: everything
 * raised in one iteration is sent in one message, because dropping a nudge
 * silently is how a loop-breaker goes missing. Order is what resolves a
 * disagreement between two of them.
 */
export const STEER_KINDS = {
  security: 100,
  loop: 90,
  // A call of the model's own that was malformed and not run: it has to hear
  // that before anything about budget or style, or it waits for a result.
  "tool-call": 85,
  budget: 80,
  verify: 70,
  outcome: 65,
  supervisor: 60,
  safety: 50,
  reflection: 40,
};

/**
 * One slot per agent run.
 *
 * @returns {{add: (kind: string, text: string) => void, take: () => object|null, size: () => number}}
 */
export function createSteering() {
  /** @type {Array<{rank: number, seq: number, text: string}>} */
  let pending = [];
  let seq = 0;

  return {
    /**
     * Raise a nudge for the next completion.
     *
     * An unknown kind throws rather than defaulting: a nudge with no rank would
     * be ordered by accident, and silently taking the lowest rank is exactly the
     * kind of fallback that hides a typo until someone reads a payload.
     */
    add(kind, text) {
      const rank = STEER_KINDS[kind];
      if (rank === undefined) throw new Error(`unknown steering kind: ${kind}`);
      if (typeof text !== "string" || !text.trim()) return;
      // The same line twice in one payload teaches the model nothing and was
      // half of what the measurement found.
      if (pending.some((p) => p.text === text)) return;
      pending.push({ rank, seq: seq++, text });
    },

    /** Take everything raised since the last completion, as one message. Clears. */
    take() {
      if (!pending.length) return null;
      const ordered = [...pending].sort((a, b) => b.rank - a.rank || a.seq - b.seq);
      pending = [];
      return { role: "system", content: ordered.map((p) => p.text).join("\n\n") };
    },

    size() {
      return pending.length;
    },
  };
}
