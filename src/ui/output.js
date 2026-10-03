// Output formatting module
// Single source of truth for all chat output styling and indentation
//
// Hierarchy:
//   USER     "  > message"                    (highlighted bg)
//   AGENT    "  text"                         (normal, 2-space indent)
//   TOOL     "    tool -> result"             (dim, 4-space indent)
//   CHILD    "  ✦ Agent@port:"               (cyan, with box drawing)
//   CHILD    "  │ response line"              (cyan border)
//   PROCESS  "  ┌ [bg:1] command"            (dim, with box drawing)
//   PROCESS  "  │ output line"               (dim)
//   PROCESS  "  └ [bg:1] exit 0"             (dim)
//   SYSTEM   "  italic system info"          (gray)
//   STATS    "  --- cost | session"           (dim)

import chalk from "chalk";
import { processLedgerLine } from "./tool-ledger.js";
import { highlight as hlHighlight } from "cli-highlight";
import { createLogger } from "../logging/logger.js";

const log = createLogger("ui-output");

let _store = null;

export function initOutput(store) {
  log.debug("initOutput", { hasStore: !!store });
  _store = store;
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;

function addLine(text) {
  const plain = (text || "").replace(ANSI_RE, "").slice(0, 80);
  log.debug("addLine", { len: (text || "").length, preview: plain });
  _store.getState().addLine(text);
}

// Word-wrap text to fit terminal width, preserving indent on wrapped lines
function wrapLines(indent, text, cols) {
  const maxWidth = cols - indent.length;
  if (maxWidth <= 10) { addLine(indent + text); return; }
  const plain = text.replace(ANSI_RE, "");
  if (plain.length <= maxWidth) { addLine(indent + text); return; }
  // Split on words, re-wrap
  const words = text.split(" ");
  let line = "";
  let lineLen = 0;
  for (const word of words) {
    const wordLen = word.replace(ANSI_RE, "").length;
    if (lineLen > 0 && lineLen + 1 + wordLen > maxWidth) {
      addLine(indent + line);
      line = word;
      lineLen = wordLen;
    } else {
      line = lineLen > 0 ? line + " " + word : word;
      lineLen = lineLen > 0 ? lineLen + 1 + wordLen : wordLen;
    }
  }
  if (line) addLine(indent + line);
}

// --- User message (highlighted bar) ---
export function printUser(text) {
  const cols = process.stdout.columns || 80;
  const ANSI_RE = /\x1b\[[0-9;]*m/g;
  const plain = text.replace(ANSI_RE, "");
  const pad = Math.max(0, cols - plain.length - 2);
  addLine("");
  addLine(chalk.bgGray.whiteBright(` ${text}${" ".repeat(pad)} `));
  addLine("");
}

// --- Inline markdown rendering ---
function renderMarkdown(text) {
  // Code blocks (``` ... ```) — already handled line-by-line in printAgent
  // Inline code `text`
  text = text.replace(/`([^`]+)`/g, (_, code) => chalk.cyan(code));
  // Bold **text** or __text__
  text = text.replace(/\*\*([^*]+)\*\*/g, (_, b) => chalk.bold(b));
  text = text.replace(/__([^_]+)__/g, (_, b) => chalk.bold(b));
  // Italic *text* or _text_ (but not inside words like file_name)
  text = text.replace(/(?<!\w)\*([^*]+)\*(?!\w)/g, (_, i) => chalk.italic(i));
  text = text.replace(/(?<!\w)_([^_]+)_(?!\w)/g, (_, i) => chalk.italic(i));
  return text;
}

// Track code block state across calls
let _inCodeBlock = false;
let _codeBlockLang = "";
let _codeBlockLines = [];

// Track markdown table buffering across calls
let _tableBuffer = [];

// Markdown table line: starts and ends with |, has at least one inner |
const TABLE_LINE_RE = /^\s*\|.+\|\s*$/;
// Separator line: | --- | --- | (with optional colons for alignment)
const TABLE_SEP_RE = /^\s*\|[\s:]*-{2,}[\s:]*\|/;

function flushTable() {
  if (_tableBuffer.length < 2) {
    // Not enough lines for a table — dump as plain text
    for (const line of _tableBuffer) {
      wrapLines("  ", renderMarkdown(line), process.stdout.columns || 80);
    }
    _tableBuffer = [];
    return;
  }

  // Find separator row
  let sepIdx = _tableBuffer.findIndex((l) => TABLE_SEP_RE.test(l));
  let headerRow, dataRows;

  if (sepIdx === 1) {
    // Standard: header, separator, data rows
    headerRow = _tableBuffer[0];
    dataRows = _tableBuffer.slice(2);
  } else if (sepIdx === 0) {
    // Separator first — treat first data row as header
    headerRow = _tableBuffer[1] || "";
    dataRows = _tableBuffer.slice(2);
  } else {
    // No separator — first row is header, rest are data
    headerRow = _tableBuffer[0];
    dataRows = _tableBuffer.slice(1);
  }

  const parseRow = (line) =>
    line.split("|").slice(1, -1).map((c) => c.trim());

  const columns = parseRow(headerRow);
  const rows = dataRows
    .filter((l) => !TABLE_SEP_RE.test(l)) // skip any extra separators
    .map(parseRow);

  if (columns.length > 0 && rows.length > 0) {
    _store.getState().addTable({ columns, rows });
  } else {
    // Fallback: dump as text
    for (const line of _tableBuffer) {
      wrapLines("  ", renderMarkdown(line), process.stdout.columns || 80);
    }
  }

  _tableBuffer = [];
}

// --- Agent (main) response line ---
export function printAgent(text) {
  const cols = process.stdout.columns || 80;

  // Markdown table lines — buffer and flush as Table component
  if (!_inCodeBlock && TABLE_LINE_RE.test(text)) {
    _tableBuffer.push(text);
    return;
  }
  // Non-table line after table buffer — flush table first
  if (_tableBuffer.length > 0) {
    flushTable();
  }

  // Code block fence
  if (/^```/.test(text)) {
    if (!_inCodeBlock) {
      _inCodeBlock = true;
      _codeBlockLang = text.slice(3).trim();
      _codeBlockLines = [];
      return;
    } else {
      // Closing fence — flush buffered code with syntax highlighting
      flushCodeBlock();
      return;
    }
  }

  // Inside code block — buffer lines for syntax highlighting
  if (_inCodeBlock) {
    _codeBlockLines.push(text);
    return;
  }

  // Markdown headings
  const headingMatch = text.match(/^(#{1,3})\s+(.+)$/);
  if (headingMatch) {
    const level = headingMatch[1].length;
    const content = headingMatch[2];
    if (level === 1) { addLine(""); addLine("  " + chalk.bold.underline(content)); addLine(""); }
    else if (level === 2) { addLine(""); addLine("  " + chalk.bold(content)); }
    else { addLine("  " + chalk.bold(content)); }
    return;
  }

  // Horizontal rule
  if (/^[-*_]{3,}\s*$/.test(text)) {
    addLine("  " + chalk.dim("-".repeat(Math.min(40, cols - 4))));
    return;
  }

  // Unordered list items
  const listMatch = text.match(/^(\s*)[*-]\s+(.+)$/);
  if (listMatch) {
    const depth = Math.floor(listMatch[1].length / 2);
    const indent = "  " + "  ".repeat(depth);
    wrapLines(indent, chalk.dim("-") + " " + renderMarkdown(listMatch[2]), cols);
    return;
  }

  // Ordered list items
  const olMatch = text.match(/^(\s*)\d+\.\s+(.+)$/);
  if (olMatch) {
    const depth = Math.floor(olMatch[1].length / 2);
    const indent = "  " + "  ".repeat(depth);
    wrapLines(indent, renderMarkdown(olMatch[2]), cols);
    return;
  }

  // Regular text with inline markdown
  wrapLines("  ", renderMarkdown(text), cols);
}

// Flush buffered code block with syntax highlighting
function flushCodeBlock() {
  const code = _codeBlockLines.join("\n");
  const lang = _codeBlockLang || "";
  _inCodeBlock = false;
  _codeBlockLines = [];
  _codeBlockLang = "";

  addLine("  " + chalk.dim("─".repeat(3) + " " + (lang || "code") + " " + "─".repeat(Math.max(0, 40 - (lang || "code").length))));

  try {
    const opts = lang ? { language: lang, ignoreIllegals: true } : { ignoreIllegals: true };
    const highlighted = hlHighlight(code, opts);
    for (const line of highlighted.split("\n")) {
      addLine("  " + line);
    }
  } catch {
    // Fallback to cyan if highlighting fails
    for (const line of code.split("\n")) {
      addLine("  " + chalk.cyan(line));
    }
  }

  addLine("  " + chalk.dim("─".repeat(44)));
}

// Flush any buffered state (call at end of agent response)
export function flushAgentState() {
  log.debug("flushAgentState", { tableBufferLen: _tableBuffer.length, inCodeBlock: _inCodeBlock });
  if (_tableBuffer.length > 0) flushTable();
  if (_inCodeBlock && _codeBlockLines.length > 0) flushCodeBlock();
  _inCodeBlock = false;
}

// --- Agent streaming placeholder (shown during tool execution) ---
export function setAgentStream(text) {
  const plain = (text || "").replace(ANSI_RE, "").slice(0, 60);
  log.debug("setAgentStream", { len: (text || "").length, preview: plain });
  _store.getState().setStreamText(text ? `  ${text}` : "");
}

// --- Background process streaming (one updating line per process) ---
export function setProcessStream(procId, text) {
  _store.getState().setProcessStream(procId, text ? `    ${chalk.dim("|")} ${chalk.dim(text)}` : "");
}

// --- Tool result (compact, dim) ---
export function printTool(toolName, argsShort, resultShort) {
  addLine(`    ${chalk.dim(toolName)} ${chalk.dim(argsShort)} ${chalk.dim("->")} ${chalk.gray(resultShort)}`);
}

export function printToolDenied(toolName, argsShort) {
  addLine(`    ${chalk.yellow(toolName)} ${chalk.dim(argsShort)} ${chalk.red("DENIED")}`);
}


// --- Child agent response (box with cyan border) ---
export function printChildAgent(port, response, maxLines = 20, label) {
  const name = label || `Agent@${port}`;
  const lines = response.split("\n");
  const cols = process.stdout.columns || 80;
  addLine(`  ${chalk.cyan("*")} ${chalk.cyan(`${name}:`)}`);
  const show = lines.slice(0, maxLines);
  const border = `  ${chalk.cyan("|")} `;

  // Detect and render markdown tables within child response
  let tableBuf = [];
  const flushChildTable = () => {
    if (tableBuf.length < 2) {
      for (const tl of tableBuf) wrapLines(border, renderMarkdown(tl), cols);
      tableBuf = [];
      return;
    }
    const sepIdx = tableBuf.findIndex((l) => TABLE_SEP_RE.test(l));
    const headerRow = sepIdx === 1 ? tableBuf[0] : tableBuf[0];
    const dataStart = sepIdx >= 0 ? Math.max(sepIdx + 1, 2) : 1;
    const parseRow = (l) => l.split("|").slice(1, -1).map((c) => c.trim());
    const columns = parseRow(headerRow);
    const rows = tableBuf.slice(dataStart).filter((l) => !TABLE_SEP_RE.test(l)).map(parseRow);
    if (columns.length > 0 && rows.length > 0) {
      _store.getState().addTable({ columns, rows });
    } else {
      for (const tl of tableBuf) wrapLines(border, renderMarkdown(tl), cols);
    }
    tableBuf = [];
  };

  for (const line of show) {
    if (TABLE_LINE_RE.test(line)) {
      tableBuf.push(line);
      continue;
    }
    if (tableBuf.length > 0) flushChildTable();
    wrapLines(border, renderMarkdown(line), cols);
  }
  if (tableBuf.length > 0) flushChildTable();

  if (lines.length > maxLines) {
    addLine(`  ${chalk.cyan("|")} ${chalk.dim(`... +${lines.length - maxLines} lines`)}`);
  }
  addLine(`  ${chalk.cyan("\\-")}`);
}

// --- Child agent status ---
export function printChildSpawn(port, pid, label) {
  const name = label || `agent@${port}`;
  addLine(`  ${chalk.cyan("*")} ${chalk.cyan(`Spawned ${name} on port ${port}`)} ${chalk.dim(`(pid ${pid})`)}`);
}

export function printChildEvent(port, text, label) {
  const name = label || `Agent@${port}`;
  addLine(`  ${chalk.cyan("*")} ${chalk.dim(`${name} ${text}`)}`);
}

// --- Background process output (dim, box drawing, 4-space indent) ---
// A background process's start is the ledger's "sh start" line (its outcome
// column names the process); only its end and the all-finished summary are
// printed here, in the ledger's style (owner, 2026-10-01: the start used to be
// printed twice, once here and once by the ledger).
export function printProcessEnd(procId, cmd, exitCode, elapsed, status) {
  // Stopped with /kill: say so, not the exit code taskkill left behind.
  const how = status === "killed" ? "killed" : exitCode === 0 ? "done" : `exit ${exitCode ?? "?"}`;
  // After a kill, what is still running and what the next Esc would stop, on
  // the same line (owner, 2026-10-01: Esc used to print a line of its own and
  // then this one, two lines for one press).
  const left = status === "killed"
    ? (_store?.getState().processes || []).filter((p) => p.status === "running").length
    : 0;
  const hint = left ? chalk.dim(`  · ${left} still running, Esc stops the newest`) : "";
  addLine(processLedgerLine({ verb: how, cmd, procId, elapsed }) + hint);
}

export function printProcessSummary(total, done, failed, killed) {
  const parts = [];
  if (done) parts.push(`${done} done`);
  if (failed) parts.push(`${failed} failed`);
  if (killed) parts.push(`${killed} killed`);
  addLine(chalk.dim(`      ── all ${total} background processes finished: ${parts.join(", ")} ──`));
}

// --- Stats line ---
export function printStats(iters, costStr, sessionCost) {
  addLine(`  ${chalk.dim(`--- ${iters}${costStr} | session $${sessionCost}`)}`);
}

// --- System / info messages ---
export function printSystem(text) {
  addLine(`  ${chalk.gray(text)}`);
}

export function printWarning(text) {
  addLine(`  ${chalk.yellow(text)}`);
}

export function printError(text) {
  addLine(`  ${chalk.red(text)}`);
}

// --- Confirmation prompt ---
/**
 * One history line for an answered approval. The question itself is shown
 * only in the live zone while it waits (components/LiveZone.js).
 */
export function printConfirmResult(type, toolName = "", argsText = "", server = "") {
  const what = `${toolName}${argsText ? " " + argsText : ""}`.slice(0, 100);
  if (type === "allow") addLine(chalk.green("  + ") + chalk.dim(what));
  else if (type === "always") addLine(chalk.green("  + ") + chalk.dim(what) + chalk.green(" (always)"));
  else if (type === "server") addLine(chalk.green("  + ") + chalk.dim(what) + chalk.green(` (always, all of ${server})`));
  else addLine(chalk.red("  x denied ") + chalk.dim(what));
}

// --- Table rendering ---
export function printTable(columns, rows, title, footer) {
  _store.getState().addTable({ columns, rows, title, footer });
}

// --- Blank line ---
export function printBlank() {
  addLine("");
}
