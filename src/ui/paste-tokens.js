// Pasted text and images stand in the input as short tokens (owner,
// 2026-10-01): a big paste shows as "[Pasted text #1 · 42 lines]", a picture
// as "[Image #1]". The full text is put back when the message is sent; the
// history line keeps the token.

// A single input event this big is a paste worth hiding behind a token.
// Typing and dictation arrive a character or a word at a time, and a paste of
// two or three lines reads fine as it is.
const PASTE_MIN_CHARS = 300;
const PASTE_MIN_LINES = 4;
// Further chunks of the same paste arrive within this window.
export const PASTE_MERGE_MS = 150;

const TOKEN_RE = /\[Pasted text #(\d+)[^\]]*\]/g;
const IMAGE_TOKEN_RE = /\[Image #(\d+)\]/g;

/** Does one inserted chunk look like a paste? */
export function isPasteChunk(added) {
  const s = String(added || "");
  if (s.length < 2) return false;
  return s.split("\n").length >= PASTE_MIN_LINES || s.length >= PASTE_MIN_CHARS;
}

/** The token that stands for pasted text in the input. */
export function pasteToken(id, text) {
  const s = String(text || "");
  const lines = s.split("\n").length;
  const size = lines > 1 ? `${lines} lines` : `${s.length} chars`;
  return `[Pasted text #${id} · ${size}]`;
}

// How much of a paste is shown, top lines first (owner, 2026-10-01: "show two
// or three lines vertically, then +15 more").
export const PREVIEW_LINES = 3;

/** The first lines of a paste and how many more there are. */
export function previewLines(text, max = PREVIEW_LINES) {
  const lines = String(text || "").replace(/\n+$/, "").split("\n");
  return { shown: lines.slice(0, max), more: Math.max(0, lines.length - max) };
}

/**
 * The input as the history should show it: each paste token opened into its
 * first lines and a "+N more lines" note, so what was pasted can be seen
 * without the whole of it.
 */
export function previewPastes(input, pastes, max = PREVIEW_LINES) {
  return String(input || "").replace(TOKEN_RE, (whole, id) => {
    const text = pastes.get(Number(id));
    if (text == null) return whole;
    const { shown, more } = previewLines(text, max);
    const tail = more ? [`… +${more} more line${more === 1 ? "" : "s"}`] : [];
    return ["", ...shown.map((l) => `  ${l}`), ...tail.map((l) => `  ${l}`)].join("\n");
  });
}

/**
 * Rows for the block above the input while composing: for each paste token in
 * the input, a header and its first lines. At most `maxPastes` blocks, so the
 * live zone stays small.
 */
export function composeRows(input, pastes, { max = PREVIEW_LINES, maxPastes = 2 } = {}) {
  const rows = [];
  let count = 0;
  for (const m of String(input || "").matchAll(TOKEN_RE)) {
    const id = Number(m[1]);
    const text = pastes.get(id);
    if (text == null) continue;
    if (count === maxPastes) { rows.push("… more pasted text in the input"); break; }
    count++;
    const { shown, more } = previewLines(text, max);
    rows.push(`┌ pasted #${id}`);
    for (const l of shown) rows.push(`│ ${l}`);
    rows.push(more ? `└ +${more} more line${more === 1 ? "" : "s"}` : "└");
  }
  return rows;
}

/** The input with every paste token replaced by the text it stands for. */
export function expandPastes(input, pastes) {
  return String(input || "").replace(TOKEN_RE, (whole, id) => {
    const text = pastes.get(Number(id));
    return text == null ? whole : text;
  });
}

/** The image numbers referenced in the input, in order, each once. */
export function imageIds(input) {
  const ids = [];
  for (const m of String(input || "").matchAll(IMAGE_TOKEN_RE)) {
    const id = Number(m[1]);
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * Text arriving at the cursor (typed, pasted, or Ctrl+V), given the paste
 * state. A big chunk becomes a token; the next chunk of the same paste, if it
 * arrives right after that token within PASTE_MERGE_MS, grows it.
 *
 * @param {object} a
 * @param {string} a.value   the input
 * @param {number} a.cursor  where the text goes
 * @param {string} a.chunk   the text (normalized)
 * @param {Map}    a.pastes  id -> text, mutated when a paste is made or grown
 * @param {object} a.state   { nextId, last: {id, token, at} | null }, mutated
 * @param {number} [a.now]
 * @returns {{value: string, cursor: number}}
 */
export function applyInsert({ value, cursor, chunk, pastes, state, now = Date.now() }) {
  const before = value.slice(0, cursor);
  const after = value.slice(cursor);
  const last = state.last;
  if (last && now - last.at < PASTE_MERGE_MS && chunk.length > 1 && before.endsWith(last.token)) {
    const text = pastes.get(last.id) + chunk;
    pastes.set(last.id, text);
    const token = pasteToken(last.id, text);
    state.last = { id: last.id, token, at: now };
    const head = before.slice(0, before.length - last.token.length) + token;
    return { value: head + after, cursor: head.length };
  }
  if (isPasteChunk(chunk)) {
    const id = state.nextId++;
    pastes.set(id, chunk);
    const token = pasteToken(id, chunk);
    state.last = { id, token, at: now };
    return { value: before + token + after, cursor: before.length + token.length };
  }
  return { value: before + chunk + after, cursor: cursor + chunk.length };
}
