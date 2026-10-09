// One width for every window title Flint writes.
//
// The Windows taskbar sizes its entry to the title, so a title whose width
// changes (spinner glyphs of different widths, a cost line, an approval text)
// makes the whole taskbar shift. Every title is cut or padded to TITLE_WIDTH
// characters. All titles are BMP, non-wide code points, so the code point count
// is the display width.

export const TITLE_WIDTH = 44;

/** Cut with "..." or pad with spaces to exactly `width` code points. */
export function fitWidth(text, width = TITLE_WIDTH) {
  const chars = [...String(text ?? "").replace(/\s+/g, " ")];
  if (chars.length > width) return chars.slice(0, Math.max(0, width - 3)).join("") + "...";
  return chars.join("") + " ".repeat(width - chars.length);
}
