// HistoryWriter: prints finished lines into the terminal's own scrollback.
//
// docs/console-spec.md. History used to go through Ink <Static> fed with the
// store's `lines` array, which is capped at maxDisplayLines (1000). <Static>
// prints items past the count it has already printed, so once the array hit
// the cap its length stopped growing and nothing new was printed at all; and
// every remount (tab switch, back from PgUp) printed all 1000 lines again.
//
// Here each line is written once, by id, through Ink's stdout writer, which
// clears the live zone, writes above it and redraws it. Ids only grow, so the
// cap on `lines` no longer matters to what is shown, and nothing is ever
// reprinted. Scrolling and selection belong to the terminal.

import React from "react";
import { useStdout, renderToString } from "ink";
import { Table } from "./Table.js";

const { createElement: h, useEffect, useRef } = React;

/** One history item as the text the terminal should show. */
export function historyItemText(item, columns = process.stdout.columns || 80) {
  if (item?.type === "table") {
    return renderToString(
      h(Table, { columns: item.columns, rows: item.rows, title: item.title, footer: item.footer }),
      { columns },
    );
  }
  return String(item?.text ?? "");
}

/**
 * Items not yet written, given the last written id. A /clear resets ids to 1,
 * which the caller signals by passing lastId 0.
 */
export function unwrittenItems(lines, lastId) {
  return (lines || []).filter((l) => l && l.id > lastId);
}

export function HistoryWriter({ store }) {
  const { write } = useStdout();
  const lastId = useRef(0);
  const lastClear = useRef(store.getState().clearCounter || 0);
  const scheduled = useRef(false);

  useEffect(() => {
    let alive = true;
    // New lines are collected the moment they are added, not at write time:
    // `lines` keeps only the last maxDisplayLines, so a burst bigger than that
    // within one tick evicted its first lines before they were ever written
    // (acceptance check 1, 2026-10-02: lines 0 to 999 of 2,000 never shown).
    const buffer = [];
    const collect = () => {
      const s = store.getState();
      const clear = s.clearCounter || 0;
      if (clear !== lastClear.current) {
        lastClear.current = clear;
        lastId.current = 0;
        buffer.length = 0;
      }
      const fresh = unwrittenItems(s.lines, lastId.current);
      if (!fresh.length) return false;
      lastId.current = fresh[fresh.length - 1].id;
      buffer.push(...fresh);
      return true;
    };
    const flush = () => {
      scheduled.current = false;
      if (!alive || !buffer.length) return;
      const items = buffer.splice(0, buffer.length);
      write(items.map((item) => historyItemText(item)).join("\n") + "\n");
    };
    // One write per tick, not one per addLine: a streamed answer adds many
    // lines in a burst, and each write clears and redraws the live zone.
    const schedule = () => {
      if (!collect() || scheduled.current) return;
      scheduled.current = true;
      queueMicrotask(flush);
    };
    collect();
    flush();
    const unsubscribe = store.subscribe(schedule);
    return () => { alive = false; unsubscribe(); };
  }, [store, write]);

  return null;
}
