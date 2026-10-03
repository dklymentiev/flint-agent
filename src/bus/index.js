// Unified Message Bus — SQLite-backed priority queue
// All input channels (TUI, API, child agents, scheduler) push here.
// Agent loop drains by priority. Crash-safe: pending messages survive restart.

import { getDb } from "../tasks/db.js";
import { createLogger } from "../logging/logger.js";

const log = createLogger("bus");

// Ring buffer for recent bus events (for /bus/log endpoint)
const _eventLog = [];
const MAX_EVENTS = 100;
function logEvent(type, msg) {
  _eventLog.push({ type, ts: new Date().toISOString(), ...msg });
  if (_eventLog.length > MAX_EVENTS) _eventLog.shift();
}

/**
 * Get recent bus events (last N).
 * @param {number} [limit=50]
 */
export function recentEvents(limit = 50) {
  return _eventLog.slice(-limit);
}

// Priority levels (lower = higher priority)
export const PRIORITY = {
  USER: 0,      // TUI input, /commands
  API: 1,       // HTTP /message from paired client
  AGENT: 2,     // Child agent responses
  TASK: 3,      // Scheduled tasks firing
  EVENT: 4,     // Email, Telegram, external events
  SYSTEM: 5,    // BG process alerts, heartbeat
};

/**
 * Push a message onto the bus.
 * @param {object} msg
 * @param {string} msg.channel - 'user' | 'api' | 'agent' | 'scheduler' | 'telegram' | 'email' | 'voice'
 * @param {string} msg.content - Message text
 * @param {number} [msg.priority=5] - 0=highest, 10=lowest
 * @param {string} [msg.source] - Agent port, email address, etc.
 * @param {object} [msg.metadata] - Channel-specific data (stored as JSON)
 * @param {string} [msg.sessionId] - Session context
 * @returns {{ id: number }} Inserted message ID
 */
export function push({ channel, content, priority, source, metadata, sessionId }) {
  const db = getDb();
  const result = db.prepare(
    `INSERT INTO message_queue (channel, content, priority, source, metadata, session_id)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    channel,
    content,
    priority ?? PRIORITY.SYSTEM,
    source || null,
    metadata ? JSON.stringify(metadata) : null,
    sessionId || null,
  );
  const id = result.lastInsertRowid;
  log.debug("PUSH", { id, channel, priority: priority ?? PRIORITY.SYSTEM, source });
  logEvent("push", { id: Number(id), channel, priority: priority ?? PRIORITY.SYSTEM, source, contentPreview: content.slice(0, 80) });
  return { id: Number(id) };
}

/**
 * Drain the highest-priority pending message.
 * Atomically sets status = 'processing'.
 * @returns {object|null} Message row or null if queue empty
 */
export function drain() {
  const db = getDb();
  // Single atomic operation: select + update
  const msg = db.prepare(
    `SELECT * FROM message_queue
     WHERE status = 'pending'
     ORDER BY priority ASC, created_at ASC
     LIMIT 1`
  ).get();

  if (!msg) return null;

  db.prepare(
    `UPDATE message_queue SET status = 'processing', processed_at = datetime('now') WHERE id = ?`
  ).run(msg.id);

  log.debug("DRAIN", { id: msg.id, channel: msg.channel, priority: msg.priority });
  logEvent("drain", { id: msg.id, channel: msg.channel, priority: msg.priority });

  return {
    ...msg,
    status: "processing",
    metadata: msg.metadata ? JSON.parse(msg.metadata) : null,
  };
}

/**
 * Mark a message as successfully processed.
 * @param {number} id - Message ID
 * @param {string} [result] - Agent response summary (for audit)
 */
export function complete(id, result) {
  const db = getDb();
  db.prepare(
    `UPDATE message_queue SET status = 'done', result = ?, processed_at = datetime('now') WHERE id = ?`
  ).run(result || null, id);
  log.debug("DONE", { id, resultLen: result?.length || 0 });
  logEvent("done", { id, resultPreview: (result || "").slice(0, 80) });
}

/**
 * Mark a message as failed.
 * @param {number} id - Message ID
 * @param {string} [error] - Error description
 */
/**
 * Take back a message that is still waiting, for the operator to edit it
 * (Esc on an unread message). Only a pending message: once the agent has
 * taken it, it is read and cannot be recalled.
 * @returns {boolean} true if it was still pending and is now cancelled
 */
export function cancelPending(id) {
  const db = getDb();
  const r = db.prepare(
    `UPDATE message_queue SET status = 'failed', result = 'recalled for editing', processed_at = datetime('now') WHERE id = ? AND status = 'pending'`
  ).run(id);
  if (r.changes) logEvent("cancel", { id });
  return r.changes > 0;
}

export function fail(id, error) {
  const db = getDb();
  db.prepare(
    `UPDATE message_queue SET status = 'failed', result = ?, processed_at = datetime('now') WHERE id = ?`
  ).run(error || "unknown error", id);
  log.warn("FAIL", { id, error });
  logEvent("fail", { id, error });
}

/**
 * Crash recovery: reset stale 'processing' messages back to 'pending'.
 * Called on startup to recover from mid-processing crashes.
 * @param {number} [staleMinutes=5] - Messages processing longer than this are stale
 * @returns {number} Number of recovered messages
 */
export function recover(staleMinutes = 5) {
  const db = getDb();
  const result = db.prepare(
    `UPDATE message_queue
     SET status = 'pending', processed_at = NULL
     WHERE status = 'processing'
       AND processed_at < datetime('now', ? || ' minutes')`
  ).run(`-${staleMinutes}`);
  const count = result.changes;
  if (count > 0) {
    log.info("RECOVER", { count, staleMinutes });
    logEvent("recover", { count, staleMinutes });
  }
  return count;
}

// Older than this, nobody is still waiting for the answer: an API caller's
// sync wait is 180 s, a child agent's report is about work long gone.
const LEFTOVER_MAX_AGE_MINUTES = 10;

/**
 * Start-up: put this session's half-done messages back in the queue, and
 * expire what an earlier run left for someone else.
 *
 * Owner, 2026-10-02: a console started with --new drained a benchmark task an
 * API client had sent five days earlier to another session, and ran it with
 * the API's automatic approval. A message belongs to the session it was sent
 * to and to the minutes after it was sent. Expired: any message of another
 * session, and any message older than LEFTOVER_MAX_AGE_MINUTES. Reminders
 * (channel 'scheduler') are kept: they are the operator's own schedule.
 *
 * @param {object} opts
 * @param {string} opts.sessionId - The session this start runs
 * @returns {{ recovered: number, expired: number }}
 */
export function prepareQueueAtStart({ sessionId }) {
  const recovered = recover();
  const db = getDb();
  const r = db.prepare(
    `UPDATE message_queue
     SET status = 'failed', result = 'expired: left in the queue by an earlier run', processed_at = datetime('now')
     WHERE status IN ('pending', 'processing')
       AND channel != 'scheduler'
       AND ((session_id IS NOT NULL AND session_id != ?)
            OR created_at < datetime('now', ? || ' minutes'))`
  ).run(sessionId || "", `-${LEFTOVER_MAX_AGE_MINUTES}`);
  const expired = r.changes;
  if (expired > 0) {
    log.info("EXPIRE", { expired, sessionId });
    logEvent("expire", { count: expired });
  }
  return { recovered, expired };
}

/**
 * Cleanup old processed messages.
 * @param {number} [doneHours=24] - Delete 'done' messages older than this
 * @param {number} [failedDays=7] - Delete 'failed' messages older than this
 * @returns {{ done: number, failed: number }} Counts of deleted messages
 */
export function cleanup(doneHours = 24, failedDays = 7) {
  const db = getDb();
  const doneResult = db.prepare(
    `DELETE FROM message_queue
     WHERE status = 'done'
       AND processed_at < datetime('now', ? || ' hours')`
  ).run(`-${doneHours}`);
  const failedResult = db.prepare(
    `DELETE FROM message_queue
     WHERE status = 'failed'
       AND processed_at < datetime('now', ? || ' days')`
  ).run(`-${failedDays}`);
  const counts = { done: doneResult.changes, failed: failedResult.changes };
  if (counts.done + counts.failed > 0) {
    log.debug("CLEANUP", counts);
  }
  return counts;
}

/**
 * Get queue statistics for StatusBar and monitoring.
 * @returns {{ pending: number, processing: number, done: number, failed: number, total: number }}
 */
export function stats() {
  const db = getDb();
  const rows = db.prepare(
    `SELECT status, COUNT(*) as count FROM message_queue GROUP BY status`
  ).all();
  const s = { pending: 0, processing: 0, done: 0, failed: 0, total: 0 };
  for (const row of rows) {
    s[row.status] = row.count;
    s.total += row.count;
  }
  return s;
}

/**
 * Get all pending messages (for inspection, not processing).
 * @param {number} [limit=50]
 * @returns {object[]}
 */
export function pending(limit = 50) {
  const db = getDb();
  return db.prepare(
    `SELECT * FROM message_queue
     WHERE status = 'pending'
     ORDER BY priority ASC, created_at ASC
     LIMIT ?`
  ).all(limit).map(row => ({
    ...row,
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
  }));
}

/**
 * Get message by ID (for polling result).
 * @param {number} id
 * @returns {object|null}
 */
export function getMessage(id) {
  const db = getDb();
  const row = db.prepare("SELECT * FROM message_queue WHERE id = ?").get(id);
  if (!row) return null;
  return { ...row, metadata: row.metadata ? JSON.parse(row.metadata) : null };
}
