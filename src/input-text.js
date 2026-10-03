// What the operator sees must be what is sent.
//
// A pasted multi-line message looked cut and overwritten in the input box,
// though the agent received it whole. Nothing was wrong with what was sent,
// which is why it never showed up in a message log — the logs looked perfect.
//
// The cause is a character the terminal and the text disagree about. A paste
// on Windows (and from some terminals) arrives with the line breaks as CRLF,
// or as a bare CR. A terminal draws a CR as "back to column 0", so the next
// line is written *over* the one before it:
//
//   paste: "line one\r\nline two\r\nline three"     30 chars, 2 CRs
//   drawn: "\nline three"                            1 line, the rest gone
//
// So the operator sees one line and sends three. They fix it by retyping the
// parts that appear to have vanished, which is the worst outcome: the
// correction is guesswork, and what finally reaches the agent is the
// retyped version, not what they pasted.
//
// The fix is here rather than in the component, because the disagreement is
// about the text, not about the drawing: normalize the line endings once, at
// the boundary, and everything downstream — the drawing, the cursor, the
// submitted message — then works on the same string. Deliberately narrow: no
// trimming, no rewrapping, no reflowing. A pasted diff, a stack trace or a
// JSON blob must arrive exactly as it was pasted, or the agent is reasoning
// about a document nobody sent.

/**
 * Does this text contain a CR that is not part of a CRLF pair?
 *
 * \r\n is an ordinary line ending and is left alone. A bare \r is not — it is
 * a control character the terminal acts on, which is the whole bug.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function hasBareCR(text) {
  if (!text) return false;
  return /\r(?!\n)/.test(String(text));
}

/**
 * The line endings a terminal cannot draw, turned into ones it can.
 *
 * CRLF first, then any remaining bare CR. Doing them in that order is what
 * makes the result idempotent: after one pass there is no \r left at all, so
 * a second pass is a no-op. That matters because the input normalizes on
 * every keystroke.
 *
 * @param {string} text
 * @returns {string}
 */
export function normalizeInputText(text) {
  if (text === null || text === undefined) return "";
  const s = String(text);
  if (!s) return "";
  if (!s.includes("\r")) return s;
  return s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/**
 * The text as the operator will see it in the input box.
 *
 * What the terminal would draw, given text a terminal can draw. Exported
 * because "what does the operator see" is the question this whole module
 * exists to answer, and it should be answerable in a test without rendering
 * a terminal.
 *
 * @param {string} text
 * @returns {string}
 */
export function displayTextFor(text) {
  return expandTabs(normalizeInputText(text));
}

/**
 * How many lines the operator can actually see, as opposed to how many the
 * paste contained.
 *
 * Before the fix these two numbers differed, and the difference was the bug.
 *
 * @param {string} text
 * @returns {number}
 */
export function visibleLineCount(text) {
  const shown = displayTextFor(text);
  return shown ? shown.split("\n").length : 0;
}

// The tab stop the input renders at. A tab in the input is a jump to the next
// stop, so the operator sees a gap while the agent receives a 0x09; expanding
// it shows the character and the gap as the same thing.
const TAB_WIDTH = 4;

/**
 * Tabs as spaces, so what is drawn is what was typed.
 *
 * @param {string} text
 * @param {number} [tabWidth]
 * @returns {string}
 */
export function expandTabs(text, tabWidth = TAB_WIDTH) {
  if (!text) return "";
  const s = String(text);
  if (!s.includes("\t")) return s;
  let out = "";
  for (const line of s.split("\n")) {
    let col = 0;
    for (const ch of line) {
      if (ch === "\t") {
        const pad = tabWidth - (col % tabWidth);
        out += " ".repeat(pad);
        col += pad;
      } else {
        out += ch;
        col += 1;
      }
    }
    out += "\n";
  }
  // split/join added a trailing newline that the input did not have.
  return out.replace(/\n$/, "");
}
