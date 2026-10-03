// Audit logger — writes JSON lines to {sessionsDir}/audit.jsonl

import { existsSync, mkdirSync, appendFileSync, statSync, renameSync } from "node:fs";
import path from "node:path";

let auditFile = null;
let auditDir = null;
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

/**
 * Initialize audit logging.
 * @param {object} config - App config (needs sessionsDir)
 */
export function initAudit(config) {
  auditDir = config.sessionsDir;
  if (!existsSync(auditDir)) {
    mkdirSync(auditDir, { recursive: true });
  }
  auditFile = path.join(auditDir, "audit.jsonl");
}

/**
 * Rotate audit file if it exceeds MAX_FILE_SIZE.
 */
function rotateIfNeeded() {
  if (!auditFile) return;
  try {
    if (!existsSync(auditFile)) return;
    const stat = statSync(auditFile);
    if (stat.size >= MAX_FILE_SIZE) {
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const rotated = path.join(auditDir, `audit-${ts}.jsonl`);
      renameSync(auditFile, rotated);
    }
  } catch {
    // Rotation failure is non-fatal
  }
}

/**
 * Write an audit log entry.
 * @param {string} event - Event type (TOOL_CALL, DENIED, etc.)
 * @param {string} toolName - Tool name
 * @param {object} args - Tool arguments (will be truncated)
 * @param {object} [extra] - Additional data
 */
export function auditLog(event, toolName, args, extra) {
  if (!auditFile) return;

  try {
    rotateIfNeeded();

    // Truncate args for logging
    const safeArgs = {};
    if (args && typeof args === "object") {
      for (const [k, v] of Object.entries(args)) {
        const s = typeof v === "string" ? v : JSON.stringify(v);
        safeArgs[k] = s.length > 200 ? s.slice(0, 200) + "..." : s;
      }
    }

    const entry = {
      ts: new Date().toISOString(),
      event,
      tool: toolName || null,
      args: safeArgs,
      ...(extra || {}),
    };

    appendFileSync(auditFile, JSON.stringify(entry) + "\n");
  } catch {
    // Audit logging failure is non-fatal
  }
}

/**
 * Create audit beforeHook — logs TOOL_CALL events.
 * @returns {Function} beforeHook(name, args)
 */
export function createAuditBeforeHook() {
  return function auditBeforeHook(name, args) {
    auditLog("TOOL_CALL", name, args);
    return null; // never block
  };
}

/**
 * Create audit afterHook — logs TOOL_RESULT events.
 * @returns {Function} afterHook(name, args, result)
 */
export function createAuditAfterHook() {
  return function auditAfterHook(name, args, result) {
    const resultStr = result != null ? String(result) : "";
    const truncated = resultStr.length > 100 ? resultStr.slice(0, 100) + "..." : resultStr;
    auditLog("TOOL_RESULT", name, args, { resultPreview: truncated });
    return null; // don't transform result
  };
}
