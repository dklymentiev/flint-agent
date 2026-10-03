// Table — Ink React component for tabular data
import React from "react";
import { Box, Text } from "ink";

const { createElement: h } = React;

// A markdown table reaches this component with its cells as the model wrote
// them, and the model marks what matters: `**8**`, `` `/projects/flint` ``.
// Printed raw, the markers stayed on screen and were counted into the column
// width (owner, 2026-10-03). Only the two marks that cannot be mistaken for
// data are read: a pair of `**` or `__` around text, and a pair of backticks.
// Single `_` and `*` are left alone on purpose, a table is where utm_source,
// file_name and 2*3 live.
const MARK_RE = /\*\*([^*]+)\*\*|__([^_]+)__|`([^`]+)`/g;

/**
 * A cell as pieces of text with their style: [{ text, bold?, code? }].
 * The pieces joined are what the reader sees, and what widths are measured on.
 */
export function cellSegments(cell) {
  const str = String(cell ?? "");
  const out = [];
  let at = 0;
  for (const m of str.matchAll(MARK_RE)) {
    if (m.index > at) out.push({ text: str.slice(at, m.index) });
    if (m[3] !== undefined) out.push({ text: m[3], code: true });
    else out.push({ text: m[1] ?? m[2], bold: true });
    at = m.index + m[0].length;
  }
  if (at < str.length) out.push({ text: str.slice(at) });
  return out;
}

const visible = (cell) => cellSegments(cell).map((s) => s.text).join("");

/** Column widths for the terminal: data-sized, and the last column takes the rest. */
export function tableWidths(columns, rows, cols) {
  const widths = columns.map((col, i) => {
    const headerLen = visible(col).length;
    const maxData = rows.reduce((max, row) => Math.max(max, visible(row[i]).length), 0);
    return Math.min(Math.max(headerLen, maxData) + 1, 40);
  });

  // Adjust last column to fill remaining space
  const usedWidth = widths.slice(0, -1).reduce((s, w) => s + w + 3, 4);
  widths[widths.length - 1] = Math.max(widths[widths.length - 1], cols - usedWidth - 2);
  return widths;
}

/**
 * The cell's pieces cut or padded to exactly n visible characters. The cut
 * used to keep n - 1 characters and add "...", which made the row two wider
 * than its neighbours and sent its closing bar to the next line.
 */
function fitCell(cell, n) {
  const segments = cellSegments(cell);
  const length = segments.reduce((s, x) => s + x.text.length, 0);
  if (length <= n) return [...segments, { text: " ".repeat(n - length) }];

  const dots = n >= 3 ? "..." : "";
  let room = n - dots.length;
  const out = [];
  for (const s of segments) {
    if (room <= 0) break;
    const text = s.text.slice(0, room);
    out.push({ ...s, text });
    room -= text.length;
  }
  if (dots) out.push({ text: dots });
  return out;
}

export function Table({ columns, rows, title, footer }) {
  const cols = process.stdout.columns || 80;
  const widths = tableWidths(columns, rows, cols);

  // One Text per piece, not one string per row: bold inside a dimmed string
  // ends the dimming for the rest of the line, because both are switched off
  // by the same terminal code.
  const dim = (key, text) => h(Text, { key, dimColor: true }, text);
  const piece = (key, s) => {
    if (s.bold) return h(Text, { key, bold: true }, s.text);
    if (s.code) return h(Text, { key, color: "cyan" }, s.text);
    return dim(key, s.text);
  };

  const makeLine = (key, cells) => {
    const parts = [dim("open", "  | ")];
    widths.forEach((w, i) => {
      if (i > 0) parts.push(dim(`sep-${i}`, " | "));
      fitCell(cells[i], w).forEach((s, j) => parts.push(piece(`c-${i}-${j}`, s)));
    });
    parts.push(dim("close", " |"));
    return h(Text, { key }, ...parts);
  };

  const border = "  +" + widths.map((w) => "-".repeat(w + 2)).join("+") + "+";

  const elements = [];

  if (title) {
    elements.push(h(Text, { key: "title", color: "cyan" }, `  ${title}`));
  }

  elements.push(h(Text, { key: "top", dimColor: true }, border));
  elements.push(makeLine("header", columns));
  elements.push(h(Text, { key: "div", dimColor: true }, border));

  for (let r = 0; r < rows.length; r++) {
    elements.push(makeLine(`r-${r}`, rows[r]));
  }

  elements.push(h(Text, { key: "bot", dimColor: true }, border));

  if (footer) {
    elements.push(h(Text, { key: "footer", dimColor: true }, `  ${footer}`));
  }

  return h(Box, { flexDirection: "column" }, ...elements);
}
