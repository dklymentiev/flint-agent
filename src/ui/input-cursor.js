// The real terminal cursor: a thin bar, placed by LineInput (cursorCell in
// ui/line-edit.js) at the edit position.
//
// Owner, 2026-10-01: the drawn inverse block showed up in random places, so it
// was turned off; with it gone there was no caret at all. A real terminal
// cursor is what every other console shows, and it is also where IME and
// dictation tools put their text.

// DECSCUSR: 5 = blinking bar, 0 = the terminal's own default.
export const CURSOR_BAR = "\x1b[5 q";
export const CURSOR_DEFAULT = "\x1b[0 q";

/** Row of an Ink DOM node within the live output, the way Ink's layout.js sums it. */
export function absoluteTop(node) {
  let y = 0;
  let current = node;
  while (current?.parentNode) {
    if (!current.yogaNode) return null;
    y += current.yogaNode.getComputedTop();
    current = current.parentNode;
  }
  return current ? y : null;
}
