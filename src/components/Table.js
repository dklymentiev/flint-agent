// Table — Ink React component for tabular data
import React from "react";
import { Box, Text } from "ink";

const { createElement: h } = React;

export function Table({ columns, rows, title, footer }) {
  const cols = process.stdout.columns || 80;

  // Calculate column widths from data
  const widths = columns.map((col, i) => {
    const headerLen = String(col).length;
    const maxData = rows.reduce((max, row) => Math.max(max, String(row[i] || "").length), 0);
    return Math.min(Math.max(headerLen, maxData) + 1, 40);
  });

  // Adjust last column to fill remaining space
  const usedWidth = widths.slice(0, -1).reduce((s, w) => s + w + 3, 4);
  widths[widths.length - 1] = Math.max(widths[widths.length - 1], cols - usedWidth - 2);

  const pad = (s, n) => {
    const str = String(s);
    return str.length > n ? str.slice(0, n - 1) + "..." : str.padEnd(n);
  };

  const makeLine = (cells, sep) =>
    "  | " + cells.map((c, i) => pad(c, widths[i])).join(` ${sep} `) + " |";

  const borderTop = "  +" + widths.map((w) => "-".repeat(w + 2)).join("+") + "+";
  const borderBot = borderTop;
  const divider = "  +" + widths.map((w) => "-".repeat(w + 2)).join("+") + "+";

  const elements = [];

  if (title) {
    elements.push(h(Text, { key: "title", color: "cyan" }, `  ${title}`));
  }

  elements.push(h(Text, { key: "top", dimColor: true }, borderTop));
  elements.push(h(Text, { key: "header", dimColor: true }, makeLine(columns, "|")));
  elements.push(h(Text, { key: "div", dimColor: true }, divider));

  for (let r = 0; r < rows.length; r++) {
    elements.push(h(Text, { key: `r-${r}`, dimColor: true }, makeLine(rows[r], "|")));
  }

  elements.push(h(Text, { key: "bot", dimColor: true }, borderBot));

  if (footer) {
    elements.push(h(Text, { key: "footer", dimColor: true }, `  ${footer}`));
  }

  return h(Box, { flexDirection: "column" }, ...elements);
}
