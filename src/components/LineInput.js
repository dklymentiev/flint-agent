// LineInput: the console's input line with a real cursor (owner, 2026-10-01).
//
// Replaces ink-text-input, whose cursor was either drawn as an inverse block
// that showed up in odd places, or, with showCursor off, did not move at all.
// This one draws no caret of its own: the App puts the terminal's thin bar
// cursor where `cursor` is (ui/line-edit.js cursorCell). Paste/image tokens
// move and delete as one character.
//
// Keys: Left/Right, Ctrl+Left/Right (also Alt+B/F) by word, Home/End and
// Ctrl+A/E, Backspace, Delete, Ctrl+W (word back), Ctrl+U (clear), Enter.
// Up/Down, Esc, Tab and the App's own Ctrl shortcuts are left to the App.

import React from "react";
import { Text, useInput } from "ink";
import {
  moveLeft, moveRight, wordLeft, wordRight, insertAt, backspace,
  deleteForward, deleteWordBack, wrapRows,
} from "../ui/line-edit.js";

const { createElement: h } = React;

const same = (a, b) => a.value === b.value && a.cursor === b.cursor;

export function LineInput({ value, cursor, onChange, onSubmit, onInsert, mask, focus = true, width = 80, rowStart = 0, maxRows = Infinity }) {
  // Keys can arrive faster than renders (a paste in chunks, dictation). The
  // line is kept here and updated on every key, so a second key never sees the
  // state from before the first. `pending` holds what was sent up and not yet
  // seen back as props: props that match one of those are this component's
  // own echo; anything else is the App replacing the line (history recall,
  // clearing on submit), which wins.
  const stateRef = React.useRef({ value, cursor });
  const pendingRef = React.useRef([]);
  const fromProps = { value, cursor };
  const echo = pendingRef.current.findIndex((p) => same(p, fromProps));
  if (echo >= 0) pendingRef.current = pendingRef.current.slice(echo + 1);
  else if (!same(stateRef.current, fromProps)) { stateRef.current = fromProps; pendingRef.current = []; }

  useInput((input, key) => {
    const state = stateRef.current;
    ({ value, cursor } = state);
    if (key.return) { onSubmit?.(value); return; }
    if (key.upArrow || key.downArrow || key.escape || key.tab || key.pageUp || key.pageDown) return;

    let next = null;
    if (key.leftArrow) next = key.ctrl || key.meta ? wordLeft(state) : moveLeft(state);
    else if (key.rightArrow) next = key.ctrl || key.meta ? wordRight(state) : moveRight(state);
    else if (key.home || (key.ctrl && input === "a")) next = { value, cursor: 0 };
    else if (key.end || (key.ctrl && input === "e")) next = { value, cursor: value.length };
    else if (key.meta && input === "b") next = wordLeft(state);
    else if (key.meta && input === "f") next = wordRight(state);
    else if (key.backspace) next = backspace(state);
    else if (key.delete) next = deleteForward(state);
    else if (key.ctrl && input === "w") next = deleteWordBack(state);
    else if (key.ctrl && input === "u") next = { value: "", cursor: 0 };
    else if (key.ctrl || key.meta) return; // the App's shortcuts (Ctrl+C, Ctrl+V, ...)
    else if (input) next = onInsert ? onInsert(input, state) : insertAt(state, input);

    if (next && !same(next, state)) {
      stateRef.current = next;
      pendingRef.current.push(next);
      onChange?.(next);
    }
  }, { isActive: focus });

  const drawn = mask ? mask.repeat(value.length) : value;
  // A long line shows only the rows around the cursor (the App picks
  // rowStart), so the input cannot push the live output to the window height.
  return h(Text, null, wrapRows(drawn, width).slice(rowStart, rowStart + maxRows).join("\n"));
}
