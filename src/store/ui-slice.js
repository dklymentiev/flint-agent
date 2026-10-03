// UI slice: lines[], streamText, activeTab
import { config } from "../config.js";
import { createLogger } from "../logging/logger.js";

const log = createLogger("ui-slice");

export const createUiSlice = (set, get) => ({
  lines: [],       // [{id, text}]
  nextLineId: 1,
  streamText: "",
  processStreams: {},  // procId → text, one updating line per background process
  activeTab: "chat", // "chat" | "toollog" | "processes" | "system"
  headerPrinted: false, // guard: prevent duplicate header on tab-cycle

  setActiveTab(tab) {
    set({ activeTab: tab });
  },

  /**
   * One history line. `replay: true` marks a line shown again from the
   * session's chat log (ui/replay.js); the chat log follower skips it, so the
   * log does not get its own lines a second time.
   */
  addLine(text, opts = {}) {
    const { nextLineId, lines } = get();
    const maxLines = config.maxDisplayLines || 1000;
    const item = { id: nextLineId, text: String(text) || " " };
    if (opts.replay) item.replay = true;
    const updated = [...lines, item];
    log.debug("addLine", { id: nextLineId, totalLines: updated.length, textLen: (text || "").length });
    set({
      lines: updated.length > maxLines ? updated.slice(-maxLines) : updated,
      nextLineId: nextLineId + 1,
    });
  },

  addTable({ columns, rows, title, footer }) {
    const { nextLineId, lines } = get();
    const maxLines = config.maxDisplayLines || 1000;
    const item = { id: nextLineId, type: "table", columns, rows, title, footer };
    const updated = [...lines, item];
    set({
      lines: updated.length > maxLines ? updated.slice(-maxLines) : updated,
      nextLineId: nextLineId + 1,
    });
  },

  // Messages the operator typed while the agent worked and it has not read
  // yet: shown above the input, moved into the history when read (owner,
  // 2026-10-01: printed lines cannot be marked read afterwards).
  queuedInputs: [], // [{ id: busId, display }]
  addQueuedInput(entry) {
    set({ queuedInputs: [...get().queuedInputs, entry] });
  },
  /** Remove and return the entry for a bus message, or null. */
  takeQueuedInput(id) {
    const list = get().queuedInputs;
    const entry = list.find((q) => q.id === id) || null;
    if (entry) set({ queuedInputs: list.filter((q) => q !== entry) });
    return entry;
  },
  clearQueuedInputs() {
    set({ queuedInputs: [] });
  },

  setStreamText(text) {
    log.debug("setStreamText", { len: (text || "").length, empty: !text });
    set({ streamText: text });
  },

  setProcessStream(procId, text) {
    const streams = { ...get().processStreams };
    if (text) {
      streams[procId] = text;
    } else {
      delete streams[procId];
    }
    set({ processStreams: streams });
  },

  // Overlay menu state
  overlay: null,        // null | { type: "provider" | "model", title, items, index, parent }
  openOverlay(type, title, items) {
    set({ overlay: { type, title, items, index: 0, parent: null, loading: false, sortMode: "name" } });
  },
  overlayDrilldown(type, title, items, parent) {
    set({ overlay: { type, title, items, index: 0, parent, loading: false, sortMode: "name" } });
  },
  overlayCycleSort() {
    const o = get().overlay;
    if (!o) return;
    const modes = ["name", "price", "context"];
    const next = modes[(modes.indexOf(o.sortMode || "name") + 1) % modes.length];
    set({ overlay: { ...o, sortMode: next, index: 0 } });
  },
  overlaySetIndex(index) {
    const o = get().overlay;
    if (o) set({ overlay: { ...o, index } });
  },
  overlaySetLoading(loading) {
    const o = get().overlay;
    if (o) set({ overlay: { ...o, loading } });
  },
  closeOverlay() {
    set({ overlay: null });
  },

  clearCounter: 0,

  clearScreen() {
    const { clearCounter, _inkClear } = get();
    // 1. ANSI: clear scrollback + visible screen + move cursor home
    process.stdout.write("\x1b[3J\x1b[2J\x1b[H");
    // 2. Ink: reset internal output tracking so it doesn't re-render old Static lines
    if (_inkClear) _inkClear();
    // 3. Reset lines array so Static starts fresh
    set({ lines: [], nextLineId: 1, streamText: "", activeTab: "chat", clearCounter: clearCounter + 1, headerPrinted: false });
  },
});
