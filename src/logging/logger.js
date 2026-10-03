// Structured logger with levels: debug, info, warn, error
// Level from .env AGENT_LOG_LEVEL (default: "info")
// All levels >= configured write to sessions/<sessionId>.log
// warn+ also goes to stderr

import "dotenv/config"; // ensure .env is loaded before anything else
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3, silent: 4 };
const LEVEL_NAMES = Object.fromEntries(Object.entries(LEVELS).map(([k, v]) => [v, k]));

const _rawLevel = process.env.AGENT_LOG_LEVEL;
const _level = LEVELS[(_rawLevel || "info").trim()] ?? LEVELS.info;
let _logFile = null;
let _buffer = []; // buffer messages before initLogger sets the file
let _inkActive = false; // suppress stderr when Ink TUI is rendering

/**
 * Initialize logger with session info. Call once after session is created.
 * @param {{ sessionsDir: string, sessionId: string }} opts
 */
export function initLogger(opts = {}) {
  if (opts.sessionsDir && opts.sessionId && _level < LEVELS.silent) {
    try {
      mkdirSync(opts.sessionsDir, { recursive: true });
      _logFile = path.join(opts.sessionsDir, `${opts.sessionId}.log`);
      // Flush buffered messages
      if (_buffer.length > 0) {
        writeFileSync(_logFile, _buffer.join("\n") + "\n");
        _buffer = [];
      }
    } catch {}
  }
}

/**
 * Set log level at runtime.
 * @param {"debug"|"info"|"warn"|"error"|"silent"} level
 */
export function setLogLevel(level) {
  // Note: can't reassign const, but we can use this for future dynamic level
}

/**
 * Suppress stderr output when Ink TUI is active.
 * stderr.write during Ink rendering corrupts terminal layout.
 */
export function setInkActive(active) {
  _inkActive = active;
}

/** @returns {"debug"|"info"|"warn"|"error"|"silent"} */
export function getLogLevel() {
  return LEVEL_NAMES[_level] || "info";
}

function formatMsg(level, module, msg, data) {
  const d = new Date();
  const ts = `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}:${String(d.getSeconds()).padStart(2,"0")}.${String(d.getMilliseconds()).padStart(3,"0")}`;
  const prefix = `[${ts}] [${level.toUpperCase()}] [${module}]`;
  let line = `${prefix} ${msg}`;
  if (data !== undefined) {
    const extra = typeof data === "string" ? data : JSON.stringify(data);
    line += ` ${extra}`;
  }
  return line;
}

function emit(levelNum, level, module, msg, data) {
  if (levelNum < _level) return;

  const line = formatMsg(level, module, msg, data);

  // Write to log file (or buffer if file not ready yet)
  if (_logFile) {
    try { appendFileSync(_logFile, line + "\n"); } catch {}
  } else {
    _buffer.push(line);
  }

  // Write to stderr for warn+ ONLY when Ink TUI is NOT active
  // stderr.write during Ink rendering breaks cursor positioning and causes UI duplication
  if (levelNum >= LEVELS.warn && !_inkActive) {
    process.stderr.write(line + "\n");
  }
}

/**
 * Create a scoped logger for a module.
 * @param {string} module - Module name (e.g. "server", "pairing", "heartbeat")
 * @returns {{ debug, info, warn, error }}
 */
export function createLogger(module) {
  return {
    debug: (msg, data) => emit(LEVELS.debug, "debug", module, msg, data),
    info: (msg, data) => emit(LEVELS.info, "info", module, msg, data),
    warn: (msg, data) => emit(LEVELS.warn, "warn", module, msg, data),
    error: (msg, data) => emit(LEVELS.error, "error", module, msg, data),
  };
}

// Log boot immediately
const _bootLog = createLogger("boot");
_bootLog.info("Logger initialized", {
  level: LEVEL_NAMES[_level],
  cwd: process.cwd(),
  argv: process.argv.slice(2).join(" "),
  AGENT_PORT: process.env.AGENT_PORT || "(default)",
  AGENT_PARENT_PORT: process.env.AGENT_PARENT_PORT || "(none)",
  pid: process.pid,
});
