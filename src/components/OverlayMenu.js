// OverlayMenu — interactive selection list rendered in place of tab content
import React from "react";
import { Box, Text } from "ink";
import stringWidth from "string-width";

const { createElement: h } = React;

/** Cut to a display width, with an ellipsis; wide characters count as two. */
export function fitEnd(str, width) {
  const s = String(str || "");
  if (stringWidth(s) <= width) return s;
  let out = "";
  for (const ch of s) {
    if (stringWidth(out + ch) > width - 1) break;
    out += ch;
  }
  return out + "…";
}

/** "10-02 14:24" for a session's last change, local time. */
export function sessionWhen(date) {
  if (!date || Number.isNaN(date.getTime?.())) return "";
  const p = (n) => String(n).padStart(2, "0");
  return `${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}`;
}

function pad(str, len) {
  return str.length >= len ? str.slice(0, len) : str + " ".repeat(len - str.length);
}

export function OverlayMenu({ overlay, height }) {
  if (!overlay) return null;

  const { title, items: rawItems, index, loading, type, sortMode } = overlay;

  // Sort items for model view
  const items = type === "model" && sortMode && sortMode !== "name"
    ? [...rawItems].sort((a, b) => {
        if (sortMode === "price") {
          return (a._priceNum ?? Infinity) - (b._priceNum ?? Infinity);
        }
        if (sortMode === "context") {
          return (b._ctxNum ?? 0) - (a._ctxNum ?? 0);
        }
        return 0;
      })
    : rawItems;
  const cols = process.stdout.columns || 80;

  if (loading) {
    return h(Box, { flexDirection: "column", height },
      h(Text, { bold: true, color: "cyan" }, `  ${title}`),
      h(Text, { dimColor: true }, ""),
      h(Text, { color: "yellow" }, "  Loading..."),
    );
  }

  if (!items || !items.length) {
    return h(Box, { flexDirection: "column", height },
      h(Text, { bold: true, color: "cyan" }, `  ${title}`),
      h(Text, { dimColor: true }, ""),
      h(Text, { color: "red" }, "  No items available"),
      h(Text, { dimColor: true }, ""),
      h(Text, { dimColor: true }, "  Esc: back"),
    );
  }

  // Viewport scrolling for long lists
  const maxVisible = Math.max(3, height - 6); // title + header + footer + hints
  let startIdx = 0;
  if (items.length > maxVisible) {
    startIdx = Math.max(0, Math.min(index - Math.floor(maxVisible / 2), items.length - maxVisible));
  }
  const visibleItems = items.slice(startIdx, startIdx + maxVisible);

  // Calculate column widths from all items
  const isModel = type === "model";

  let headerLine = null;
  let renderItem;

  if (type === "free") {
    // marker | model | window | speed | first token | uptime | note
    const idW = Math.min(44, Math.max(12, ...items.map((it) => (it.id || "").length)) + 1);
    const num = (v, unit, digits = 0) => (v == null ? "—" : `${Number(v).toFixed(digits)}${unit}`);
    const win = (c) => (c ? (c >= 1_000_000 ? `${Math.round(c / 1_000_000)}M` : `${Math.round(c / 1000)}k`) : "—");
    headerLine = h(Text, { key: "hdr", dimColor: true },
      `    ${pad("Model", idW)} ${pad("Check", 6)} ${pad("Window", 7)} ${pad("Speed", 10)} ${pad("First token", 12)} Uptime`
    );
    renderItem = (item, realIdx) => {
      const selected = realIdx === index;
      const marker = selected ? ">" : " ";
      const note = [item.light ? "light" : "", item.stealth ? "stealth: prompts may be logged" : ""].filter(Boolean).join(" · ");
      return h(Text, { key: realIdx, bold: selected, color: selected ? "green" : "white", wrap: "truncate" },
        `  ${marker} ${pad(item.id || "", idW)} ${pad(item.checkScore == null ? "—" : `${item.checkScore}/6${item.scoreFresh ? "" : "*"}`, 6)} ${pad(win(item.context), 7)} ${pad(num(item.tps, " tok/s"), 10)} ${pad(item.firstMs == null ? "—" : num(item.firstMs / 1000, " s", 1), 12)} ${num(item.uptime, "%", 1)}${note ? `  ${note}` : ""}`
      );
    };
  } else if (type === "session") {
    // marker | when | messages | the last thing asked in it
    const whenW = 11, countW = 5;
    const lastW = Math.max(10, Math.min(cols, 140) - whenW - countW - 8);
    headerLine = h(Text, { key: "hdr", dimColor: true },
      `    ${pad("When", whenW)} ${pad("Msgs", countW)} Last message`
    );
    renderItem = (item, realIdx) => {
      const selected = realIdx === index;
      const marker = selected ? ">" : " ";
      return h(Text, { key: realIdx, bold: selected, color: selected ? "green" : "white", wrap: "truncate" },
        `  ${marker} ${pad(sessionWhen(item.when), whenW)} ${pad(String(item.count ?? ""), countW)} ${fitEnd(item.last || "(no text)", lastW)}`
      );
    };
  } else if (isModel) {
    // Table layout: marker | model id | context | price in / price out
    const idW = Math.min(45, Math.max(10, ...items.map((it) => (it.id || "").length)) + 1);
    const ctxW = 6;
    const priceW = 22;

    headerLine = h(Text, { key: "hdr", dimColor: true },
      `    ${pad("Model", idW)} ${pad("Ctx", ctxW)} ${pad("Price (per 1M tok)", priceW)}`
    );

    renderItem = (item, realIdx) => {
      const selected = realIdx === index;
      const marker = selected ? ">" : " ";
      const id = pad(item.id || "", idW);
      const ctx = pad(item.ctx || "", ctxW);
      const price = item.price || "";
      const cur = item.current ? " *" : "";
      const color = selected ? "green" : item.current ? "cyan" : "white";

      return h(Text, { key: realIdx, bold: selected, color },
        `  ${marker} ${id} ${ctx} ${price}${cur}`
      );
    };
  } else {
    // Provider list: marker | id | name | key status
    const idW = Math.max(12, ...items.map((it) => (it.id || "").length)) + 1;
    const nameW = Math.max(16, ...items.map((it) => (it.name || "").length)) + 1;

    headerLine = h(Text, { key: "hdr", dimColor: true },
      `    ${pad("ID", idW)} ${pad("Name", nameW)} Key`
    );

    renderItem = (item, realIdx) => {
      const selected = realIdx === index;
      const marker = selected ? ">" : " ";
      const id = pad(item.id || "", idW);
      const name = pad(item.name || "", nameW);
      const info = item.info || "";
      const cur = item.current ? " *" : "";
      const color = selected ? "green" : item.disabled ? "gray" : "white";

      return h(Text, { key: realIdx, bold: selected, color },
        `  ${marker} ${id} ${name} ${info}${cur}`
      );
    };
  }

  const lines = visibleItems.map((item, i) => renderItem(item, startIdx + i));

  const scrollInfo = items.length > maxVisible
    ? `  ${startIdx + 1}-${Math.min(startIdx + maxVisible, items.length)} / ${items.length}`
    : `  ${items.length} items`;

  const sep = "  " + "-".repeat(Math.min(70, cols - 4));

  return h(Box, { flexDirection: "column", height },
    h(Text, { bold: true, color: "cyan" }, `  ${title}`),
    headerLine,
    h(Text, { dimColor: true }, sep),
    ...lines,
    h(Text, { dimColor: true }, sep),
    h(Text, { dimColor: true },
      isModel
        ? `  Up/Down: navigate | Enter: select | Ctrl+S: sort (${sortMode || "name"}) | Esc: back${scrollInfo}`
        : `  Up/Down: navigate | Enter: select | Esc: back${scrollInfo}`
    ),
  );
}
