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

export const RESTART_CODE = 42;

/**
 * Exit for a restart after `delayMs`, telling the launcher which session to
 * continue. The exit waits for the message to be sent.
 */
export function restartKeepingSession(sessionId, delayMs = 100, proc = process) {
  setTimeout(() => {
    const exit = () => proc.exit(RESTART_CODE);
    if (sessionId && typeof proc.send === "function" && proc.connected !== false) {
      try {
        proc.send({ type: "flint:restart", sessionId }, () => exit());
        return;
      } catch {}
    }
    exit();
  }, delayMs);
}
