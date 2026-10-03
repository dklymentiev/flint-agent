// Restart Flint and keep the session.
//
// Exit code 42 tells the launcher to start Flint again, and it used to start
// it with --new: every restart (/restart, POST /restart, restart_agent) left
// the conversation behind. Owner, 2026-10-02: an investigation in progress
// was cut off by a restart and had to be found again with /sessions.
//
// Before exiting, the session id goes to the launcher over the IPC channel it
// opens for us (launcher.js), and the launcher starts the new process with
// --session <id>. Run without a launcher (no IPC) it is a plain exit 42.
// The same message carries the /allow-all or /deny-all level, see below.

import { getBulkPermission } from "./tools/permissions.js";

export const RESTART_CODE = 42;

// /allow-all and /deny-all are kept in memory only, on purpose: written to
// disk, an agent that was talked into it could grant itself everything for
// good. So every restart dropped the level while keeping the session, and a
// restart is what adding an MCP server or /update needs; the owner typed
// /allow-all again each time (2026-10-03). The level now travels with the
// restart, over the same IPC channel as the session id: the launcher holds it
// while the old process exits and gives it to the new one. Nothing is
// written, and a start that is not a restart gets nothing.
const BULK_LEVELS = new Set(["allow", "deny"]);

/**
 * The blanket level in a message from the launcher, or null. Anything but
 * the two known levels is ignored.
 */
export function carriedBulkPermission(msg) {
  const level = msg && typeof msg === "object" ? msg.bulkPermission : null;
  return BULK_LEVELS.has(level) ? level : null;
}

/**
 * Exit for a restart after `delayMs`, telling the launcher which session to
 * continue. The exit waits for the message to be sent.
 */
export function restartKeepingSession(sessionId, delayMs = 100, proc = process) {
  setTimeout(() => {
    const exit = () => proc.exit(RESTART_CODE);
    if (sessionId && typeof proc.send === "function" && proc.connected !== false) {
      try {
        const bulkPermission = getBulkPermission();
        proc.send({ type: "flint:restart", sessionId, ...(bulkPermission ? { bulkPermission } : {}) }, () => exit());
        return;
      } catch {}
    }
    exit();
  }, delayMs);
}
