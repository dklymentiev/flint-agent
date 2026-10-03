# Flint console

Status: implemented, 2026-10-01/02 (branches `console-polish`, merged, and
`paste-placeholders`). This document describes the console as built; the
"Why" section keeps the reasons it was rebuilt. The agent core, bus and API
are unchanged by it.

## Goal

A plain terminal chat that never flickers, never jumps, and never loses what
was typed. The conversation is ordinary terminal output; only a small zone at
the bottom is live.

## Why the old console misbehaved

1. **Full-screen redraws.** Ink clears the terminal and reprints the whole
   session on every render once its live output is as tall as the window
   (`node_modules/ink/build/ink.js`). The old tabs and the PgUp view were.
2. **Two scroll systems.** Native scrollback plus a home-made viewport driven
   by a raw stdin listener.
3. **Background output inside the conversation**, scrolling the history.
4. **Silent Esc**: it killed background processes with no word about it.
5. **History stopped after 1000 lines**: `<Static>` printed only items past
   the count it had printed, and `lines` is capped at 1000.

## Layout

```
  ...native terminal scrollback (history, written once)...
 > user message
  answer text
      fs    read    src/index.js                  12 KB    8ms
      sh    run     npm test                      exit 0   4.1s
  answer text
      ── turn 3 · 2 tools · 22k in / 300 out tok · 6.2s · $0.0000 ──
      sh    run     ping -n 15 127.0.0.1  | Reply from ...   <- running tool
  queued  a message typed meanwhile   · Esc to edit         <- unread
  [bg 2] npm run dev  | ready on :5173                      <- process dock
------------------------------------------------------------------------
> input line, wraps by character, real cursor
------------------------------------------------------------------------
 ⠓ writing   00:07  ↓ 312 tok │ model | $0.0000 | ctx 22k/1M | 1 bg | care: normal | /help
```

- **History** (`HistoryWriter`): every finished line written once, by id,
  through Ink's stdout writer. New lines are collected the moment they are
  added, so a burst larger than the line cap is not lost. Scrolling and
  selection are the terminal's own.
- **Live zone** (`LiveZone.js layoutLiveZone`): the parts below, filled into a
  row budget so the live output always stays below the window height.
  Order of importance: approval, running tool, unread messages, background
  processes, paste preview. A part that does not fit folds into one line
  (the paste preview is dropped). The input shows at most 40% of the window,
  one row while a question waits, the rows around the cursor.
- **Footer**: a fixed-width activity block (a 2x2 dot spinner while busy, a
  dot and `ready` when idle; one verb:
  ready, thinking, writing, running, retrying; mm:ss; tokens arriving),
  then session facts: model, cost, context as size/limit, background count,
  queue, care level, /help.

## Behaviour

### Sending
- Idle: the message goes to history at once and the turn starts.
- Busy: the message waits above the input as `queued  <text>`. When the
  running turn takes it in (between steps), it moves into history with
  `✓ read` (or `✓ read all N`) right under it. If the turn ends first, it
  moves into history when its own turn starts.
- Esc with an empty input takes the newest unread message back into the input
  for editing (only while the agent has not read it).
- The agent's system prompt tells it to wait in steps of at most 15 s, so a
  message is read within about that.

### Agent output
- Answer text goes to history line by line.
- Each tool call is one dim **ledger** line: category (fs, sh, web, mem, plan,
  agent, mcp), verb, argument (long ones cut in the middle), measured result
  (exit code, size, `bg N`, denied, error), duration; fixed columns, at most
  60% of the window wide.
- A running tool shows the same columns above the input with its latest
  output line.
- Each turn ends with a **receipt**: turn number, tools, files the turn
  changed (read off the disk), tokens in/out, time, cost.

### Background processes
- Output never enters the history; a dock shows up to 3 running processes
  with their last line (no repeat counters); the footer counts them.
- Start and end are ledger lines (`sh start ... bg 3`, `sh done|killed|exit N
  ... bg 3 2m 54s`); a batch's end is one summary line.
- `/ps`, `/logs <id>`, `/kill <id>`, `/kill all`. The screen shows the
  command; the model sees its own label.

### Esc and Ctrl+C
- **Esc**, in order: clear the input; else take back the newest unread
  message; else stop the running turn (queue kept); each further press stops
  the newest background process, then the next, then child agents. A stopped
  process's ledger line says what is still running.
- **Ctrl+C**: stops the turn; a second press within 2 s exits. With
  background processes running, the second press warns and the third exits.

### Approvals
- Shown in the live zone only: `? <tool>    [y] yes  [n] no  [a] always`, and
  under it the **whole** command, wrapped, never cut. A command too long for
  the live zone is printed in full into the history and pointed to.
- One key answers; Esc means no; the input is not focused meanwhile.
- History keeps one line with the answer.
- The care level decides which tools ask (safe, normal, permissive;
  `/careful`).

### Input
- One line with a real cursor: Left/Right, Ctrl+Left/Right (Alt+B/F),
  Home/End (Ctrl+A/E), Backspace and Delete at the cursor, Ctrl+W, Ctrl+U,
  Up/Down history. The terminal's thin bar cursor is drawn at the cursor.
- A paste of four or more lines or 300+ characters becomes
  `[Pasted text #N · L lines]`; a block above the input shows its first
  three lines and `+N more`; the history line shows the same; the model gets
  the full text. Tokens move and delete as one character.
- Ctrl+V: a picture becomes `[Image #N]` and is sent with the text around it.

### Former tabs, as commands
`/tools [n]`, `/ps`, `/logs <id>`, `/kill`, `/sys`: each prints a snapshot
into the history once. `/model` and `/provider` pick lists take the live
zone's place and budget.

## Acceptance checks

| # | Check | How it is verified |
|---|-------|--------------------|
| 1 | 2,000 history lines: each printed once; a live redraw costs the same as at the start | `tests/unit/components/console-acceptance.test.js` on a headless xterm |
| 2 | Mouse-select and copy history while the agent streams | manual: the history is ordinary scrollback |
| 3 | A message typed during a turn is visible at once, then read | `queued-messages.test.js`, live check |
| 4 | Ten background processes: output never in the chat; Esc stops the newest each press; `/kill all` stops all | `console-live-zone.test.js`, `console-glitch.test.js`, live check |
| 5 | The live output stays below the window height at any size | `live-zone-budget.test.js` (10 to 40 rows, fully loaded) |
| 6 | Resizing mid-turn: no duplicated or torn history lines | `console-acceptance.test.js` (narrow, then widen) with the Ink reflow patch |
| 7 | Windows Terminal, conhost, a Linux terminal | Windows Terminal live; conhost and Linux not yet checked |
