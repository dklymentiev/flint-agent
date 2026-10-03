// The tool ledger: one line per tool call in history, and the receipt that
// closes a turn. Flint's own look (owner, 2026-10-01): a category tag, a verb,
// the argument, and the measured result right-aligned, like a ledger:
//
//   fs   read    docs/guide.md                         24 KB    12ms
//   sh   run     ping -n 5 127.0.0.1                  exit 0    4.1s
//   web  search  node lts                              2 KB     0.8s
//
//   ── turn 7 · 4 tools · changed fib.js · 6.2s · $0.0000 ──

import chalk from "chalk";
import stringWidth from "string-width";

// name -> [category, verb]. Anything else falls back by prefix, then "tool".
const TOOLS = {
  read_file: ["fs", "read"], write_file: ["fs", "write"], edit_file: ["fs", "edit"],
  delete_file: ["fs", "delete"], copy_file: ["fs", "copy"], move_file: ["fs", "move"],
  create_directory: ["fs", "mkdir"], list_directory: ["fs", "list"], glob: ["fs", "glob"],
  search_in_files: ["fs", "grep"], view_image: ["fs", "view"],
  run_command: ["sh", "run"], run_background_command: ["sh", "start"],
  kill_process: ["sh", "kill"], list_processes: ["sh", "ps"], peek_process: ["sh", "peek"],
  web_search: ["web", "search"], web_fetch: ["web", "fetch"],
  memory_write: ["mem", "write"], memory_search: ["mem", "search"], memory_get: ["mem", "get"],
  memory_delete: ["mem", "delete"], memory_expand: ["mem", "expand"],
  skill_add: ["mem", "skill+"], skill_update: ["mem", "skill"], skill_remove: ["mem", "skill-"],
  create_plan: ["plan", "create"], update_task: ["plan", "update"], add_task: ["plan", "add"],
  list_tasks: ["plan", "list"], create_subtask: ["plan", "sub"], add_task_note: ["plan", "note"],
  link_task_file: ["plan", "link"], list_goals: ["plan", "goals"], focus_goal: ["plan", "focus"],
  task_stats: ["plan", "stats"], today: ["plan", "today"],
  spawn_agent: ["agent", "spawn"], ask_agent: ["agent", "ask"], list_agents: ["agent", "list"],
  wait_tasks: ["agent", "wait"],
  mesh_search: ["mesh", "search"], mesh_add: ["mesh", "add"], mesh_recent: ["mesh", "recent"],
};

/** [category, verb] for a tool name. */
export function toolCategory(name) {
  const n = String(name || "");
  if (TOOLS[n]) return TOOLS[n];
  if (n.startsWith("mcp_") || n.includes("__")) {
    // mcp_<server>_<tool>: the server is the useful part.
    const parts = n.replace(/^mcp_/, "").split(/__|_/);
    return ["mcp", parts[0] || "call"];
  }
  if (n.startsWith("desktop_")) return ["desk", n.slice(8)];
  return ["sys", n.replace(/_/g, " ")];
}

/** The one argument worth showing, as a single line. */
export function toolArgument(args) {
  const a = args && typeof args === "object" ? args : {};
  const v = a.command ?? a.path ?? a.file_path ?? a.pattern ?? a.query ?? a.url ?? a.content ?? a.name ?? a.goal ?? a.title ?? "";
  return String(typeof v === "string" ? v : JSON.stringify(v)).replace(/\s+/g, " ").trim();
}

function bytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** The measured result: exit code, size, error or denial. */
const lineCount = (t) => (t ? String(t).split("\n").length : 0);

export function toolOutcome(name, result, denied, args = {}) {
  if (denied) return { text: "denied", bad: true };
  const s = typeof result === "string" ? result : (result && result._table ? `${result.rows?.length || 0} rows` : String(result ?? ""));
  if (result && result._table) return { text: s, bad: false };
  const exit = s.match(/^Error \(exit (\d+)\)/);
  if (exit) return { text: `exit ${exit[1]}`, bad: true };
  if (/^Error\b/.test(s)) return { text: "error", bad: true };
  if (name === "run_command") return { text: "exit 0", bad: false };
  // A write or an edit is measured by what it put in the file, not by its
  // one-line reply: "fs write ... 51 B" was the length of "File written:
  // <path>" for a 7.8 KB document (owner, 2026-10-02).
  if (name === "write_file" && typeof args?.content === "string") {
    return { text: bytes(Buffer.byteLength(args.content, "utf8")), bad: false };
  }
  if (name === "edit_file" && typeof args?.new_text === "string") {
    return { text: `-${lineCount(args.old_text)} +${lineCount(args.new_text)}`, bad: false };
  }
  // A started background process is named by its id, which /logs and /kill use.
  const bg = s.match(/^Background process started \(id: (\d+)/);
  if (bg) return { text: `bg ${bg[1]}`, bad: false };
  return { text: bytes(Buffer.byteLength(s, "utf8")), bad: false };
}

export function formatDuration(ms) {
  if (ms == null || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60000);
  return `${m}m${String(Math.round((ms % 60000) / 1000)).padStart(2, "0")}s`;
}

function fit(text, width) {
  if (width <= 0) return "";
  if (stringWidth(text) <= width) return text + " ".repeat(width - stringWidth(text));
  let out = "";
  for (const ch of text) {
    if (stringWidth(out + ch) > width - 1) break;
    out += ch;
  }
  return out + "…" + " ".repeat(Math.max(0, width - stringWidth(out) - 1));
}

/** Cut from the middle, so a path keeps its start and its file name. */
export function fitMiddle(text, width) {
  const s = String(text);
  if (width <= 0) return "";
  if (stringWidth(s) <= width) return s + " ".repeat(width - stringWidth(s));
  const keepEnd = Math.max(1, Math.floor((width - 1) * 0.6));
  const keepStart = Math.max(1, width - 1 - keepEnd);
  const chars = [...s];
  let head = "";
  for (const ch of chars) {
    if (stringWidth(head + ch) > keepStart) break;
    head += ch;
  }
  let tail = "";
  for (let i = chars.length - 1; i >= 0; i--) {
    if (stringWidth(chars[i] + tail) > keepEnd) break;
    tail = chars[i] + tail;
  }
  const out = `${head}…${tail}`;
  return out + " ".repeat(Math.max(0, width - stringWidth(out)));
}

// The ledger is secondary to the conversation (owner, 2026-10-01): indented,
// uncoloured, and no wider than 60% of the window, with fixed columns so the
// result and the time sit in the same place on every line.
const INDENT = "      ";
const CAT_COL = 6;
const VERB_COL = 8;
const OUT_COL = 9;
const DUR_COL = 7;

/** The width the ledger and the receipt use: 60% of the window, within reason. */
export function ledgerWidth(columns = process.stdout.columns || 80) {
  return Math.min(columns - 1, Math.max(56, Math.floor(columns * 0.6)));
}

/** One ledger line, dim, left-aligned columns, fixed width. */
export function ledgerLine({ name, args, result, denied, ms, columns = process.stdout.columns || 80 }) {
  const [cat, verb] = toolCategory(name);
  const outcome = toolOutcome(name, result, denied, args);
  const width = ledgerWidth(columns);
  const argCol = Math.max(10, width - INDENT.length - CAT_COL - VERB_COL - OUT_COL - DUR_COL - 1);
  const line = INDENT
    + fit(cat, CAT_COL)
    + fit(verb, VERB_COL)
    + fitMiddle(toolArgument(args), argCol) + " "
    + fit(outcome.text, OUT_COL)
    + formatDuration(ms);
  return chalk.dim(line.trimEnd());
}

/**
 * A background process ending, in the same columns as the ledger:
 *   sh    done    ping -n 180 127.0.0.1             bg 6     3m 2s
 * `verb` is done, killed or "exit N"; `elapsed` is already formatted.
 */
export function processLedgerLine({ verb, cmd, procId, elapsed, columns = process.stdout.columns || 80 }) {
  const width = ledgerWidth(columns);
  const argCol = Math.max(10, width - INDENT.length - CAT_COL - VERB_COL - OUT_COL - DUR_COL - 1);
  const line = INDENT
    + fit("sh", CAT_COL)
    + fit(verb, VERB_COL)
    + fitMiddle(String(cmd || ""), argCol) + " "
    + fit(`bg ${procId}`, OUT_COL)
    + String(elapsed || "");
  return chalk.dim(line.trimEnd());
}

/**
 * The line that closes a turn. `files` is the list the agent loop read off the
 * disk (null when it could not tell), so the receipt never claims more than
 * that.
 */
function tokenCount(n) {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export function receiptLine({ turn, tools, files, ms, cost, tokensIn, tokensOut, sessionCost, estimated, stopped, columns = process.stdout.columns || 80 }) {
  const parts = [`turn ${turn}`];
  parts.push(`${tools} tool${tools === 1 ? "" : "s"}`);
  if (Array.isArray(files) && files.length) {
    const names = files.map((f) => String(f).split(/[\\/]/).pop());
    const shown = names.slice(0, 3).join(", ") + (names.length > 3 ? ` +${names.length - 3}` : "");
    parts.push(`changed ${shown}`);
  }
  if (stopped) parts.push(stopped);
  // Tokens for the whole turn, every call counted (owner, 2026-10-01: on a
  // free model the cost is always $0 and the token count is the real figure).
  if (tokensIn || tokensOut) parts.push(`${tokenCount(tokensIn || 0)} in / ${tokenCount(tokensOut || 0)} out tok`);
  parts.push(formatDuration(ms));
  const money = `${estimated ? "~" : ""}$${(cost || 0).toFixed(4)}`;
  parts.push(sessionCost != null ? `${money} (session $${sessionCost.toFixed(4)})` : money);
  const body = ` ${parts.join(" · ")} `;
  const width = ledgerWidth(columns);
  const left = 2;
  const right = Math.max(2, width - INDENT.length - left - stringWidth(body));
  return chalk.dim(INDENT + "─".repeat(left) + body + "─".repeat(right));
}
