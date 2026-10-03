// App: the console. History goes into the terminal's own scrollback
// (HistoryWriter); only a small live zone at the bottom is redrawn.
// docs/console-spec.md has the why: no tabs, no home-made scrolling, nothing
// that makes Ink's live output as tall as the window.
import { freeUsedToday, savedFreeLimit } from "../free-models.js";
import { config } from "../config.js";
import { getSpendLevel } from "../spend.js";
import React from "react";
import { Box, Text, useInput, useCursor } from "ink";
import stringWidth from "string-width";
import { LineInput } from "./LineInput.js";
import { absoluteTop, CURSOR_BAR, CURSOR_DEFAULT } from "../ui/input-cursor.js";
import { cursorCell, insertAt, wrapRows } from "../ui/line-edit.js";
import { normalizeInputText } from "../input-text.js";
import { applyInsert, expandPastes, imageIds, previewPastes, composeRows } from "../ui/paste-tokens.js";
import { HistoryWriter } from "./HistoryWriter.js";
import { LiveZoneTop, StatusLine, DOTS_FRAME_MS } from "./LiveZone.js";
import { OverlayMenu } from "./OverlayMenu.js";
import chalk from "chalk";

const { createElement: h, useSyncExternalStore, useState, useRef, useCallback, useEffect } = React;

// Rows the /model and /provider pick lists may take. They scroll within this.
const OVERLAY_MAX_ROWS = 10;
// Two Ctrl+C presses this close together exit Flint.
const CTRL_C_EXIT_MS = 2000;

// Stable selector — returns cached object if shallow-equal
function useStoreSelector(store, selector) {
  const prev = useRef(null);
  return useSyncExternalStore(store.subscribe, () => {
    const next = selector(store.getState());
    if (prev.current !== null && shallowEqual(prev.current, next)) {
      return prev.current;
    }
    prev.current = next;
    return next;
  });
}

function shallowEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  const keysA = Object.keys(a);
  if (keysA.length !== Object.keys(b).length) return false;
  for (const k of keysA) {
    if (a[k] !== b[k]) return false;
  }
  return true;
}

export function App({ store, onSubmit, onAbort, onQuit, onClipboard, onRecallQueued }) {
  // The line and where its cursor is (LineInput edits both).
  const [edit, setEdit] = useState({ value: "", cursor: 0 });
  const input = edit.value;
  // Replace the whole line, cursor at the end (history, clear, recall).
  const setInput = (text) => setEdit({ value: text, cursor: text.length });

  const historyIdxRef = useRef(-1);
  const savedInputRef = useRef("");
  const inputRef = useRef("");
  inputRef.current = input;
  const editRef = useRef(edit);
  editRef.current = edit;

  // Pasted text and images stand in the input as tokens (ui/paste-tokens.js).
  // Kept for the whole session, so a message recalled with Up still expands.
  const pastesRef = useRef(new Map());
  const pasteStateRef = useRef({ nextId: 1, last: null });
  const imagesRef = useRef(new Map());

  // Text arriving at the cursor. A paste on Windows arrives with bare CRs;
  // normalized here so the line, the cursor arithmetic and the submitted
  // message are one string. A big chunk becomes a paste token. Not
  // while a secret is typed: an API key must go to /key as it is.
  const handleInsert = (chunk, state) => {
    const text = normalizeInputText(chunk);
    if (store.getState().secretPrompt) return insertAt(state, text);
    return applyInsert({ ...state, chunk: text, pastes: pastesRef.current, state: pasteStateRef.current });
  };
  const lastCtrlC = useRef(0);
  const exitWarnedRef = useRef(false);

  const ui = useStoreSelector(store, (s) => ({
    inputHistory: s.inputHistory,
    streamText: s.streamText,
    model: s.model,
    contextTokens: s.lastContextTokens,
    contextEstimated: s.contextEstimated || false,
    contextLimit: s.contextLimit,
    sessionCost: s.sessionCost,
    sessionCostEstimated: s.sessionCostEstimated || false,
    queued: s.processingCount > 1 ? s.processingCount - 1 : 0,
    processes: s.processes,
    pendingConfirmation: s.pendingConfirmation ? s.pendingConfirmation.toolName : null,
    pendingConfirmationArgs: s.pendingConfirmation ? s.pendingConfirmation.argsText || null : null,
    pendingPairing: s.pendingPairing || null,
    autoMode: s.autoMode || null,
    overlay: s.overlay || null,
    // Set by /key: the next submitted line is a secret for that resolver only.
    secretPrompt: s.secretPrompt || null,
    agentStatus: s.agentStatus || "idle",
    currentTool: s.currentTool || null,
    iterationCount: s._iterationCount || 0,
    startedAt: s._startedAt || null,
    activity: s.activity || null,
    activityStartedAt: s.activityStartedAt || null,
    activityDetail: s.activityDetail || null,
    activityTokens: s.activityTokens || 0,
    queuedInputs: s.queuedInputs || [],
    // Changed by /careful; read here only so the status line redraws.
    careLevel: s._careLevel || null,
    spendLevel: s._spendLevel || getSpendLevel(),
    // Free mode: requests made today with a free model, of the daily limit.
    // Two plain numbers, not an object: the selector runs on every store
    // check, and a fresh object each time never compares equal, so React
    // re-rendered forever (error #185) as soon as free mode was on.
    freeUsed: config.freeChain ? freeUsedToday() : null,
    freeLimit: config.freeChain ? s._freeLimit || savedFreeLimit() : null,
  }));
  const { inputHistory } = ui;

  // Re-render while busy, fast enough for the running dots to move.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (ui.agentStatus === "idle") return undefined;
    const t = setInterval(() => setTick((n) => n + 1), DOTS_FRAME_MS);
    t.unref?.();
    return () => clearInterval(t);
  }, [ui.agentStatus]);

  const handleSubmit = useCallback((value) => {
    setInput("");
    historyIdxRef.current = -1;
    savedInputRef.current = "";
    // Secret mode (/key): the line goes to the waiting command only. It never
    // reaches onSubmit, so it is not sent to the model, not echoed into the
    // chat, and not added to input history.
    const secret = store.getState().secretPrompt;
    if (secret) {
      store.setState({ secretPrompt: null });
      secret.resolve(value);
      return;
    }
    // The model gets the full pasted text; the history line shows each paste
    // opened into its first lines; Up recalls the tokens.
    const images = imageIds(value).map((id) => imagesRef.current.get(id)).filter(Boolean);
    if (onSubmit) {
      onSubmit(expandPastes(value, pastesRef.current), {
        display: previewPastes(value, pastesRef.current),
        history: value,
        images,
      });
    }
  }, [onSubmit, store]);

  const handleOverlaySelect = useCallback(async (item) => {
    const s = store.getState();
    const overlay = s.overlay;
    if (!overlay) return;

    if (overlay.type === "provider") {
      // Drill into models for selected provider
      s.overlaySetLoading(true);
      try {
        const { fetchModels } = await import("../providers/models.js");
        const { hasKey } = await import("../providers/keys.js");
        const { getProvider } = await import("../providers/registry.js");
        const { readFileSync, existsSync } = await import("node:fs");
        const { homedir } = await import("node:os");
        const { join, dirname } = await import("node:path");
        const { fileURLToPath } = await import("node:url");
        const { config } = await import("../config.js");

        const provider = getProvider(item.id);
        if (provider.keyRequired && !hasKey(item.id)) {
          s.addLine(`  No API key for ${provider.name}. Use /key ${item.id} to add one.`);
          s.closeOverlay();
          return;
        }

        let models = await fetchModels(item.id);

        // Apply curated filter for openrouter (only if user has non-empty ~/.flint/models-curated.json)
        // Project default is empty [] = show all models
        if (item.id === "openrouter") {
          try {
            // homedir(), not process.env.HOME: HOME is unset on Windows.
            const userPath = join(homedir(), ".flint", "models-curated.json");
            if (existsSync(userPath)) {
              const data = JSON.parse(readFileSync(userPath, "utf-8"));
              const prefixes = Array.isArray(data[item.id]) ? data[item.id] : [];
              if (prefixes.length > 0) {
                models = models.filter((m) => prefixes.some((px) => m.id.startsWith(px)));
              }
            }
          } catch {}
        }

        if (!models.length) {
          s.addLine(`  No models returned from ${provider.name}. Check your API key and network.`);
          s.closeOverlay();
          return;
        }

        models.sort((a, b) => a.id.localeCompare(b.id));

        const modelItems = models.map((m) => {
          const ctx = m.context_length ? `${(m.context_length / 1000).toFixed(0)}k` : "";
          const price = m.pricing
            ? `$${(m.pricing.prompt * 1e6).toFixed(2)} / $${(m.pricing.completion * 1e6).toFixed(2)}`
            : "";
          return {
            id: m.id,
            ctx,
            price,
            current: m.id === config.model,
            providerId: item.id,
            _priceNum: m.pricing ? m.pricing.prompt * 1e6 : Infinity,
            _ctxNum: m.context_length || 0,
          };
        });

        s.overlayDrilldown("model", `Models -- ${provider.name}`, modelItems, {
          providerId: item.id,
          providerName: provider.name,
        });
      } catch (err) {
        s.addLine(`  Error loading models: ${err.message}`);
        s.closeOverlay();
      }
    } else if (overlay.type === "model") {
      // Apply model + provider selection
      try {
        const { config } = await import("../config.js");
        const { setActiveProvider, setLastModel } = await import("../providers/state.js");
        const { getProvider } = await import("../providers/registry.js");
        const { fetchModelInfo } = await import("../api/client.js");

        const providerId = item.providerId || overlay.parent?.providerId;
        const provider = getProvider(providerId);

        config.provider = providerId;
        setActiveProvider(providerId);
        config.model = item.id;
        setLastModel(providerId, item.id);
        s.setModel(item.id);
        s.setProvider(providerId);
        await config.resolveApiKey();

        const info = await fetchModelInfo(item.id);
        if (info) s.setPricing(info);

        s.closeOverlay();
        s.addLine(`  Switched to ${provider.name} / ${item.id}`);
      } catch (err) {
        s.addLine(`  Error: ${err.message}`);
        s.closeOverlay();
      }
    } else if (overlay.type === "free") {
      // Free mode: this model and two fallbacks from other vendors.
      s.closeOverlay();
      const { applyFreeChain } = await import("../free-models.js");
      await applyFreeChain({ chain: item.chain, limit: item.limit, store, log: (l) => s.addLine(`  ${l}`) });
    } else if (overlay.type === "session") {
      // /resume: continue the picked session, the way /load does.
      s.closeOverlay();
      const { tryHandleCommand } = await import("../commands/registry.js");
      await tryHandleCommand(`/load ${item.id}`, store);
    }
  }, [store]);


  useInput((ch, key) => {
    // Pick list (/model, /provider) owns the keyboard while open.
    if (ui.overlay) {
      const s = store.getState();
      const o = s.overlay;
      if (!o || o.loading) return;
      if (key.upArrow) { s.overlaySetIndex(Math.max(0, o.index - 1)); return; }
      if (key.downArrow) { s.overlaySetIndex(Math.min((o.items?.length || 1) - 1, o.index + 1)); return; }
      if (key.return) {
        const item = o.items?.[o.index];
        if (item) handleOverlaySelect(item);
        return;
      }
      if (key.escape) {
        if (o.parent) { if (onSubmit) onSubmit("/provider"); } else { s.closeOverlay(); }
        return;
      }
      // Ctrl+S cycles the sort mode (name, price, context)
      if (ch === "\x13" || (key.ctrl && ch === "s")) { s.overlayCycleSort(); return; }
      return;
    }

    // Ctrl+C: stop the turn; a second press within 2 s exits. Idle with text
    // in the input, it clears the input first.
    if (key.ctrl && ch === "c") {
      const now = Date.now();
      if (now - lastCtrlC.current < CTRL_C_EXIT_MS) {
        // Background processes die with Flint: say so once, and exit on the
        // next press (docs/console-spec.md, "after asking only if background
        // processes are still running").
        const running = (store.getState().processes || []).filter((p) => p.status === "running").length;
        if (running && !exitWarnedRef.current) {
          exitWarnedRef.current = true;
          lastCtrlC.current = now;
          store.getState().addLine(chalk.yellow(`  ${running} background process${running === 1 ? "" : "es"} still running. Ctrl+C again to stop ${running === 1 ? "it" : "them"} and exit.`));
          return;
        }
        onQuit?.();
        return;
      }
      exitWarnedRef.current = false;
      lastCtrlC.current = now;
      const s = store.getState();
      if (s.secretPrompt) {
        const secret = s.secretPrompt;
        store.setState({ secretPrompt: null });
        secret.resolve("");
      }
      if (inputRef.current) { setInput(""); historyIdxRef.current = -1; return; }
      if (s.agentStatus && s.agentStatus !== "idle") onAbort?.();
      s.addLine(chalk.gray("  Press Ctrl+C again to exit."));
      return;
    }

    // A pending approval is answered with one key: y, n or a. Esc means no.
    // The text input is not focused meanwhile, so the key is not typed.
    if (store.getState().pendingConfirmation) {
      const k = (ch || "").toLowerCase();
      if (k === "y" || k === "n" || k === "a") onSubmit?.(k);
      else if (key.escape) onSubmit?.("n");
      return;
    }

    if (key.escape && store.getState().secretPrompt) {
      // Esc cancels a secret prompt: resolved empty, which /key reports as Cancelled.
      const secret = store.getState().secretPrompt;
      store.setState({ secretPrompt: null });
      setInput("");
      secret.resolve("");
      return;
    }
    // Esc: clear the input if there is text; else take the newest unread
    // message back for editing; else stop the turn, then background work.
    if (key.escape) {
      if (inputRef.current) { setInput(""); historyIdxRef.current = -1; return; }
      if ((store.getState().queuedInputs || []).length) {
        const text = onRecallQueued?.();
        if (text) { setInput(text); return; }
      }
      onAbort?.();
      return;
    }

    if (key.upArrow) {
      const hist = inputHistory;
      if (!hist.length) return;
      if (historyIdxRef.current === -1) {
        savedInputRef.current = inputRef.current;
        historyIdxRef.current = hist.length - 1;
      } else if (historyIdxRef.current > 0) {
        historyIdxRef.current--;
      }
      setInput(hist[historyIdxRef.current]);
      return;
    }
    if (key.downArrow) {
      if (historyIdxRef.current === -1) return;
      const hist = inputHistory;
      if (historyIdxRef.current < hist.length - 1) {
        historyIdxRef.current++;
        setInput(hist[historyIdxRef.current]);
      } else {
        historyIdxRef.current = -1;
        setInput(savedInputRef.current);
      }
      return;
    }
    // Ctrl+U and Ctrl+W are LineInput's: they edit at the cursor.
    // Ctrl+T: print the thinking blocks of this session into history.
    if (ch === "\x14" || (key.ctrl && ch === "t")) {
      const st = store.getState();
      if (!st.thoughts.length) return;
      st.toggleThoughts();
      if (store.getState().showThoughts) {
        for (const t of st.thoughts) {
          st.addLine(chalk.gray(`  -- T[${t.id}] --`));
          const lines = t.text.split("\n");
          for (const l of lines.slice(0, 10)) st.addLine(chalk.gray(`  ${l}`));
          if (lines.length > 10) st.addLine(chalk.gray("  ..."));
        }
      } else {
        st.addLine(chalk.gray("  [thinking blocks hidden]"));
      }
      return;
    }
    // Ctrl+V / Alt+V: the clipboard goes into the input as a token, picture or
    // text, and is sent with whatever is typed around it (it used to be sent
    // at once, with "What is in this image?" if nothing had been typed).
    if ((key.ctrl && ch === "v") || (key.meta && ch === "v")) {
      const clip = onClipboard?.();
      if (!clip) { store.getState().addLine(chalk.gray("  Clipboard is empty.")); return; }
      // At the cursor, like any other insert.
      const at = editRef.current;
      const sep = at.cursor > 0 && !/\s$/.test(at.value.slice(0, at.cursor)) ? " " : "";
      if (clip.type === "image") {
        imagesRef.current.set(clip.index, clip);
        setEdit(insertAt(at, `${sep}[Image #${clip.index}] `));
      } else {
        setEdit(handleInsert(sep + clip.data, at));
      }
    }
  });

  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;

  // The real terminal cursor, as a thin bar where the line's cursor is. The
  // input row's position comes from the layout Ink computed for the previous
  // frame; when it moves, the effect below stores the new row and one more
  // render puts the cursor there. LineInput wraps the line character by
  // character, so the cell computed here is the one it draws.
  const { setCursorPosition } = useCursor();
  const inputRowRef = useRef(null);
  const [inputTop, setInputTop] = useState(null);
  const promptText = ui.secretPrompt ? `${ui.secretPrompt.label} (hidden, Esc to cancel): ` : "> ";
  const promptWidth = stringWidth(promptText);
  const lineWidth = Math.max(10, cols - 1 - promptWidth);
  const drawnInput = ui.secretPrompt ? "*".repeat(input.length) : input;
  // Height budget (owner, 2026-10-01): Ink reprints the whole session when its
  // live output reaches the window height. The input shows at most 40% of the
  // window (one row while a question waits), around the cursor; the live zone
  // gets what is left after the two rules and the status line.
  const cell = cursorCell(drawnInput, edit.cursor, lineWidth);
  const inputRows = wrapRows(drawnInput, lineWidth).length;
  const maxInputRows = ui.pendingConfirmation ? 1 : Math.max(1, Math.floor(rows * 0.4));
  const shownInputRows = Math.min(inputRows, maxInputRows);
  const rowStart = Math.max(0, Math.min(cell.row - shownInputRows + 1, inputRows - shownInputRows));
  const liveBudget = Math.max(0, rows - shownInputRows - 4);
  if (inputTop !== null && !ui.overlay) {
    setCursorPosition({ x: promptWidth + cell.col, y: inputTop + cell.row - rowStart });
  } else {
    setCursorPosition(undefined);
  }
  useEffect(() => {
    const top = absoluteTop(inputRowRef.current);
    if (top !== null && top !== inputTop) setInputTop(top);
  });
  // Bar shape while Flint owns the terminal, the terminal's default after.
  useEffect(() => {
    if (!process.stdout.isTTY) return undefined;
    process.stdout.write(CURSOR_BAR);
    const restore = () => { try { process.stdout.write(CURSOR_DEFAULT); } catch {} };
    process.on("exit", restore);
    return () => { process.off("exit", restore); restore(); };
  }, []);

  // The pick lists take the live zone's place and its budget.
  const overlayHeight = Math.max(1, Math.min(OVERLAY_MAX_ROWS, liveBudget));

  return h(
    Box,
    { flexDirection: "column" },
    h(HistoryWriter, { store }),
    ui.overlay
      ? h(OverlayMenu, { overlay: ui.overlay, height: overlayHeight })
      : h(LiveZoneTop, { state: ui, budget: liveBudget, pasteRows: ui.secretPrompt ? [] : composeRows(input, pastesRef.current) }),
    h(Box, null, h(Text, { dimColor: true }, "-".repeat(cols))),
    h(Box, { ref: inputRowRef },
      ui.secretPrompt
        ? h(Text, { color: "yellow" }, promptText)
        : h(Text, { color: "green" }, promptText),
      // No drawn caret: the real cursor is placed above, wherever the line's
      // cursor is. Arrows, Ctrl+arrows, Home/End edit anywhere in the line.
      h(LineInput, {
        value: edit.value,
        cursor: edit.cursor,
        onChange: setEdit,
        onInsert: handleInsert,
        onSubmit: handleSubmit,
        focus: !ui.pendingConfirmation,
        mask: ui.secretPrompt ? "*" : undefined,
        width: lineWidth,
        rowStart,
        maxRows: shownInputRows,
      }),
    ),
    // A rule under the input too, so the status line reads as a footer and
    // not as part of what is being typed (owner, 2026-10-01).
    h(Box, null, h(Text, { dimColor: true }, "-".repeat(cols))),
    h(StatusLine, { state: ui }),
  );
}
