// The first-run question, as a choice rather than a wall of text.
//
// The first version of this prompt was one line of three bracketed options
// and an instruction to pick a letter:
//
//   How careful should Flint be?
//   [s]afe  (asks before every change to files and every command)   [n]ormal ...
//     — pick s, n or p
//
// On 2026-09-30 11:05 the owner read that as a wall of text and did not know
// what was being asked. What was missing was not more words — it was the shape
// of a decision: a heading that says what is being decided and that this is
// asked once, then the options where the eye goes, one per line, with the
// current answer visibly current.
//
// The options come from levelOptions(), the same list the old prompt and
// parseLevelAnswer() already used, so the menu cannot offer a level that the
// parser would not record. That was the class of bug the first version hit: the
// prompt promised `n` was accepted and nothing accepted it.
import React from "react";
import { Box, Text, useInput } from "ink";
import { levelOptions, parseLevelAnswer, DEFAULT_ONBOARDING_LEVEL } from "../security/policies.js";

const { createElement: h } = React;

const DEFAULT_INDEX = Math.max(
  0,
  levelOptions().findIndex((o) => o.level === DEFAULT_ONBOARDING_LEVEL),
);

/**
 * One keystroke, as a decision.
 *
 * Returned rather than handled inline so the mapping from key to answer is a
 * value with no React in it — the arrows and the letters are two answers to
 * the same question, and a function that returns "move down" or "safe" makes
 * "Enter" the only place that has to know what either means.
 *
 * @returns {"up"|"down"|"select"|"cancel"|null}
 */
export function keyAction(ch, key, index, count) {
  if (key.upArrow) return "up";
  if (key.downArrow) return "down";
  if (key.escape) return "cancel";
  if (key.return) return "select";
  if (key.tab) return "down";
  if (!ch) return null;
  const level = parseLevelAnswer(ch);
  if (!level) return null;
  // A letter jumps to and picks its option in one keystroke, which is what
  // typing `n` did before. Kept because the prompt still advertises it.
  return level;
}

/**
 * @param {object} props
 * @param {(level: string) => void} props.onSelect — the chosen level, already
 *   validated against LEVELS by parseLevelAnswer.
 * @param {() => void} [props.onCancel] — Esc. No level is chosen, so the
 *   question comes back next start and the documented default applies: a
 *   cancelled question is not an answer.
 * @param {number} [props.initialIndex]
 */
export function CarefulMenu({ onSelect, onCancel, initialIndex = DEFAULT_INDEX }) {
  const [index, setIndex] = React.useState(initialIndex);
  const [done, setDone] = React.useState(false);
  const options = levelOptions();

  // Ref mirrors the latest index so the useInput callback always reads the
  // current value. ink's useInput registers its handler via useEffect, which
  // fires after the render commits — not synchronously within batchedUpdates.
  // A keystroke that arrives before that effect runs (e.g. Enter right after
  // arrow-down in a test) would still read the stale closure value from the
  // previous render, picking the wrong option. The ref is updated during
  // render, so it is current by the time any deferred input event arrives.
  const indexRef = React.useRef(index);
  indexRef.current = index;

  const choose = (i) => {
    if (done) return;
    // Latched before the callback: a key held down, or a key and an Enter in
    // the same tick, must not record two postures.
    setDone(true);
    onSelect(options[i].level);
  };

  useInput((ch, key) => {
    if (done) return;
    const action = keyAction(ch, key, indexRef.current, options.length);
    if (action === "up") {
      setIndex((i) => Math.max(0, i - 1));
      return;
    }
    if (action === "down") {
      setIndex((i) => Math.min(options.length - 1, i + 1));
      return;
    }
    if (action === "cancel") {
      setDone(true);
      onCancel?.();
      return;
    }
    if (action === "select") {
      choose(indexRef.current);
      return;
    }
    // A level name or its letter came through.
    const idx = options.findIndex((o) => o.level === action);
    // findIndex returns -1 when the action is not one of the levels. It used
    // to fall through to choose(-1) and crash the menu with "Cannot read
    // properties of undefined (reading 'level')" — the one keystroke this
    // component exists for, answered by pressing the wrong key, is exactly the
    // keystroke that must never throw. A junk key is not an answer and is not
    // a move either, so it is ignored, not rounded to an option.
    if (idx === -1) return;
    choose(idx);
  });

  return h(
    Box,
    { flexDirection: "column" },
    h(Text, { bold: true, color: "cyan" }, "  How careful should Flint be?"),
    h(
      Text,
      { dimColor: true },
      "  This sets when Flint asks before it changes something. It is asked once,",
    ),
    h(Text, { dimColor: true }, "  and you can change it later with /careful."),
    h(Text, { dimColor: true }, ""),
    ...options.map((option, i) => {
      const selected = i === index;
      const isDefault = option.level === DEFAULT_ONBOARDING_LEVEL;
      // The default is marked as text, not only as colour: colour is the part
      // an operator with a monochrome terminal or a screen reader never sees.
      const label = `${selected ? "❯" : " "} ${option.level}`;
      const tag = isDefault ? "  (default)" : "";
      const line = `${label}${tag}`;
      return h(
        Text,
        {
          key: option.level,
          bold: selected,
          color: selected ? "green" : isDefault ? "cyan" : "white",
        },
        `  ${line}  ${option.description}`,
      );
    }),
    h(Text, { dimColor: true }, ""),
    h(
      Text,
      { dimColor: true },
      `  Up/Down to choose, Enter to confirm, or type ${options.map((o) => o.key).join(", ")} — Esc to skip.`,
    ),
  );
}