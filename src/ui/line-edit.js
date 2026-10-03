// Editing one input line with a cursor (owner, 2026-10-01: the cursor was
// stuck at the end; arrows, Ctrl+arrows, Home/End did nothing).
//
// Pure functions over { value, cursor }. The cursor is a UTF-16 offset that
// always sits on a code point boundary and never inside a paste/image token:
// a token moves and deletes as one character.

import stringWidth from "string-width";

const TOKEN_RE = /\[(?:Pasted text #\d+[^\]]*|Image #\d+)\]/g;

/** [start, end) of every token in the value. */
export function tokenRanges(value) {
  const out = [];
  for (const m of String(value || "").matchAll(TOKEN_RE)) out.push([m.index, m.index + m[0].length]);
  return out;
}

const isLow = (c) => c >= 0xdc00 && c <= 0xdfff;

function prevPoint(value, i) {
  if (i <= 0) return 0;
  let j = i - 1;
  if (j > 0 && isLow(value.charCodeAt(j))) j--;
  return j;
}

function nextPoint(value, i) {
  if (i >= value.length) return value.length;
  let j = i + 1;
  if (j < value.length && isLow(value.charCodeAt(j))) j++;
  return j;
}

/** One step left: over a whole token if one ends here. */
export function moveLeft({ value, cursor }) {
  const t = tokenRanges(value).find(([s, e]) => e === cursor);
  return { value, cursor: t ? t[0] : prevPoint(value, cursor) };
}

/** One step right: over a whole token if one starts here. */
export function moveRight({ value, cursor }) {
  const t = tokenRanges(value).find(([s]) => s === cursor);
  return { value, cursor: t ? t[1] : nextPoint(value, cursor) };
}

const isWordChar = (ch) => /[\p{L}\p{N}_]/u.test(ch);

/** Ctrl+Left: to the start of the previous word. */
export function wordLeft({ value, cursor }) {
  let i = cursor;
  while (i > 0 && !isWordChar(value[i - 1])) i = moveLeft({ value, cursor: i }).cursor;
  while (i > 0 && isWordChar(value[i - 1])) i = prevPoint(value, i);
  return { value, cursor: i };
}

/** Ctrl+Right: to the end of the next word. */
export function wordRight({ value, cursor }) {
  let i = cursor;
  while (i < value.length && !isWordChar(value[i])) i = moveRight({ value, cursor: i }).cursor;
  while (i < value.length && isWordChar(value[i])) i = nextPoint(value, i);
  return { value, cursor: i };
}

/** Text typed or pasted at the cursor. */
export function insertAt({ value, cursor }, text) {
  return { value: value.slice(0, cursor) + text + value.slice(cursor), cursor: cursor + text.length };
}

/** Backspace: the character, or the whole token, before the cursor. */
export function backspace({ value, cursor }) {
  if (cursor <= 0) return { value, cursor };
  const t = tokenRanges(value).find(([, e]) => e === cursor);
  const from = t ? t[0] : prevPoint(value, cursor);
  return { value: value.slice(0, from) + value.slice(cursor), cursor: from };
}

/** Delete: the character, or the whole token, after the cursor. */
export function deleteForward({ value, cursor }) {
  if (cursor >= value.length) return { value, cursor };
  const t = tokenRanges(value).find(([s]) => s === cursor);
  const to = t ? t[1] : nextPoint(value, cursor);
  return { value: value.slice(0, cursor) + value.slice(to), cursor };
}

/** Ctrl+W: the word before the cursor and the space after it. */
export function deleteWordBack(state) {
  const { cursor: to } = state;
  const { cursor: from } = wordLeft(state);
  return { value: state.value.slice(0, from) + state.value.slice(to), cursor: from };
}

/** Snap a cursor out of a token and onto a code point boundary. */
export function clampCursor(value, cursor) {
  let c = Math.max(0, Math.min(cursor, value.length));
  const t = tokenRanges(value).find(([s, e]) => c > s && c < e);
  if (t) c = t[1];
  if (c > 0 && c < value.length && isLow(value.charCodeAt(c))) c--;
  return c;
}

/**
 * The value broken into rows of `width` columns, character by character (no
 * word wrap), with explicit line breaks kept. The input draws exactly these
 * rows, so the cursor position computed from them is exact.
 */
export function wrapRows(value, width) {
  const w = Math.max(1, width);
  const rows = [];
  for (const line of String(value).split("\n")) {
    let row = "";
    let cols = 0;
    for (const ch of line) {
      const cw = stringWidth(ch);
      if (cols + cw > w) { rows.push(row); row = ""; cols = 0; }
      row += ch;
      cols += cw;
    }
    rows.push(row);
  }
  return rows;
}

/**
 * Where the cursor is drawn, relative to the input's first row: the column
 * after `promptWidth`, and the row.
 */
export function cursorCell(value, cursor, width) {
  const before = wrapRows(String(value).slice(0, cursor), width);
  let row = before.length - 1;
  let col = stringWidth(before[row]);
  // At the very edge the next character starts a new row.
  if (col >= width) { row++; col = 0; }
  return { row, col };
}
