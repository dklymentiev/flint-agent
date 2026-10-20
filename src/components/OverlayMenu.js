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

/**
 * The line under the model list: how fast the marked model is now (OpenRouter,
 * fetched when the marker reaches it) and what its description begins with.
 */
export function modelDetail(item, speed) {
  if (!item) return "";
  const parts = [];
  if (speed?.loading) parts.push("speed: asking...");
  else if (speed && !speed.failed) {
    const s = [];
    if (speed.tps != null) s.push(`${Math.round(speed.tps)} tok/s`);
    if (speed.firstMs != null) s.push(`first token ${(speed.firstMs / 1000).toFixed(1)} s`);
    if (speed.uptime != null) s.push(`up ${Number(speed.uptime).toFixed(0)}%`);
    parts.push(s.length ? s.join(", ") + (speed.provider ? ` (${speed.provider})` : "") : "no speed data now");
  }
  if (item.description) parts.push(String(item.description).replace(/\s+/g, " "));
  return parts.join("  ·  ");
}

/**
 * True when every word of the filter is in the item's id, name or text, case
 * ignored: "glm 5" finds z-ai/glm-5.3.
 */
export function matchesFilter(item, filter) {
  const words = String(filter || "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = [item.id, item.name, item.last].filter(Boolean).join(" ").toLowerCase();
  return words.every((w) => hay.includes(w));
}

/**
 * The items as the list shows them: sorted (model lists, Ctrl+S), then
 * narrowed by what was typed. The keys use the same list, so Enter takes the
 * row the marker is on; it used to index the unsorted items, and after Ctrl+S
 * it picked another model than the one shown.
 */
export function overlayItems(overlay) {
  if (!overlay) return [];
  const { items: rawItems, type, sortMode, filter } = overlay;
  const sorted = type === "model" && sortMode && sortMode !== "name"
    ? [...(rawItems || [])].sort((a, b) => {
        if (sortMode === "price") {
          return (a._priceNum ?? Infinity) - (b._priceNum ?? Infinity);
        }
        if (sortMode === "context") {
          return (b._ctxNum ?? 0) - (a._ctxNum ?? 0);
        }
        return 0;
      })
    : (rawItems || []);
  return filter ? sorted.filter((it) => matchesFilter(it, filter)) : sorted;
}

export function OverlayMenu({ overlay, height }) {
  if (!overlay) return null;

  const { title, items: rawItems, index, loading, type, sortMode, filter } = overlay;
  const items = overlayItems(overlay);
  const cols = process.stdout.columns || 80;

  if (loading) {
    return h(Box, { flexDirection: "column", height },
      h(Text, { bold: true, color: "cyan" }, `  ${title}`),
      h(Text, { dimColor: true }, ""),
      h(Text, { color: "yellow" }, "  Loading..."),
    );
  }

  if (!items || !items.length) {
    const none = filter && rawItems?.length;
    return h(Box, { flexDirection: "column", height },
      h(Text, { bold: true, color: "cyan" }, `  ${title}`),
      h(Text, { dimColor: true }, ""),
      h(Text, { color: none ? "yellow" : "red" }, none ? `  Nothing matches "${filter}"` : "  No items available"),
      h(Text, { dimColor: true }, ""),
      h(Text, { dimColor: true }, none ? "  Backspace: edit | Esc: clear the search" : "  Esc: back"),
    );
  }

  // Viewport scrolling for long lists
  const detailRows = type === "model" ? 1 : 0;
  const maxVisible = Math.max(3, height - 6 - detailRows); // title + header + footer + hints (+ detail)
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

    // Tools and Can only when the provider says what its models can do.
    const known = items.some((it) => it.tools != null);
    const toolsW = 6;
    const capsW = 15;

    headerLine = h(Text, { key: "hdr", dimColor: true },
      `    ${pad("Model", idW)} ${pad("Ctx", ctxW)} ${pad("Price (per 1M tok)", priceW)}`
      + (known ? ` ${pad("Tools", toolsW)} ${pad("Can", capsW)}` : "")
    );

    renderItem = (item, realIdx) => {
      const selected = realIdx === index;
      const marker = selected ? ">" : " ";
      const id = pad(item.id || "", idW);
      const ctx = pad(item.ctx || "", ctxW);
      const price = pad(item.price || "", priceW);
      const tools = known ? ` ${pad(item.tools == null ? "?" : item.tools ? "yes" : "no", toolsW)} ${pad(item.caps || "", capsW)}` : "";
      const cur = item.current ? " *" : "";
      const color = selected ? "green" : item.current ? "cyan" : "white";

      return h(Text, { key: realIdx, bold: selected, color, wrap: "truncate" },
        `  ${marker} ${id} ${ctx} ${price}${tools}${cur}`
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

  const scrollInfo = (items.length > maxVisible
    ? `  ${startIdx + 1}-${Math.min(startIdx + maxVisible, items.length)} / ${items.length}`
    : `  ${items.length} items`) + (filter ? ` of ${rawItems.length}` : "");

  const sep = "  " + "-".repeat(Math.min(70, cols - 4));

  const marked = items[index];
  const detailLine = detailRows
    ? h(Text, { key: "detail", dimColor: true, wrap: "truncate" }, `  ${modelDetail(marked, overlay.details?.[marked?.id])}`)
    : null;

  return h(Box, { flexDirection: "column", height },
    h(Text, { wrap: "truncate" },
      h(Text, { bold: true, color: "cyan" }, `  ${title}`),
      filter
        ? h(Text, { color: "yellow" }, `   search: ${filter}_`)
        : h(Text, { dimColor: true }, "   type to search")),
    headerLine,
    h(Text, { dimColor: true }, sep),
    ...lines,
    h(Text, { dimColor: true }, sep),
    detailLine,
    h(Text, { dimColor: true },
      isModel
        ? `  Up/Down: navigate | Enter: select | Ctrl+S: sort (${sortMode || "name"}) | Esc: back${scrollInfo}`
        : `  Up/Down: navigate | Enter: select | Esc: back${scrollInfo}`
    ),
  );
}
