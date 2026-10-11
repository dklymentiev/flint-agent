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

// Whose queue this is.
//
// One ~/.flint/tasks.db serves every Flint the user starts by hand, and the
// queue used to hand any pending row to whichever instance asked first. On
// 2026-10-10 four ran at once: a task sent over the API to the Flint on port
// 3002 was run, with the API's automatic approval, by the Flint on port 3001
// in the middle of an unrelated conversation; a pairing PIN typed into one
// console was run as a message by another; and every start expired the live
// messages of the rest.
//
// A message belongs to the session it was sent to. The owner is that session,
// asked each time rather than stored: /new changes it while the process lives.
// Until index.js names it the owner is null, and a null owner sees exactly the
// rows that have no session, so there is one rule and no unguarded mode.
let _owner = () => null;

/** @param {() => (string|null)} fn - the session this process is running */
export function setOwner(fn) { _owner = fn; }

function owner() { return _owner() ?? null; }

// What this instance may see. `IS` is SQLite's null-safe equality.
//
// A reminder is the one exception: it is the operator's own schedule, not a
// message to a session, and a reminder that fired while nothing was running
// must still be there at the next start. Any instance may take one; taking it
// (drain) makes it that instance's, so it is run once.
const MINE = `(session_id IS ? OR (channel = 'scheduler' AND status = 'pending'))`;

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
 * @param {string} [msg.sessionId] - The session it is for; this instance's when not given
 * @returns {{ id: number }} Inserted message ID
 */
export function push({ channel, content, priority, source, metadata, sessionId }) {
  const db = getDb();
  // Never without an owner: /later, an autonomous run's self-continue and the
  // channel plugins push without naming a session.
  sessionId = sessionId || owner();
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
 * Drain this instance's highest-priority pending message.
 * @returns {object|null} Message row or null if nothing is waiting for it
 */
export function drain() {
  const db = getDb();
  const me = owner();
  const next = db.prepare(
    `SELECT * FROM message_queue
     WHERE status = 'pending' AND ${MINE}
     ORDER BY priority ASC, created_at ASC
     LIMIT 1`
  );
  // The claim is the UPDATE, and only a row still pending can be claimed. The
  // SELECT and the UPDATE used to be two unconditional statements, which is
  // one instance's business only while each sees its own rows; a reminder is
  // seen by all of them, and two could each have taken it. Claiming a reminder
  // also makes it the claimer's, so nobody else recovers or runs it.
  const claim = db.prepare(
    `UPDATE message_queue
     SET status = 'processing', processed_at = datetime('now'), session_id = COALESCE(?, session_id)
     WHERE id = ? AND status = 'pending'`
  );
  let msg;
  for (;;) {
    msg = next.get(me);
    if (!msg) return null;
    if (claim.run(me, msg.id).changes) break;
  }

  log.debug("DRAIN", { id: msg.id, channel: msg.channel, priority: msg.priority });
  logEvent("drain", { id: msg.id, channel: msg.channel, priority: msg.priority });

  return {
    ...msg,
    status: "processing",
    session_id: me ?? msg.session_id,
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
 * Crash recovery: reset this instance's stale 'processing' messages back to
 * 'pending'. Called on startup to recover from mid-processing crashes.
 *
 * Its own only. Another instance's row that has been 'processing' for more
 * than five minutes is a long turn, not a crash, and putting it back had it
 * run a second time.
 * @param {number} [staleMinutes=5] - Messages processing longer than this are stale
 * @returns {number} Number of recovered messages
 */
export function recover(staleMinutes = 5) {
  const db = getDb();
  const result = db.prepare(
    `UPDATE message_queue
     SET status = 'pending', processed_at = NULL
     WHERE status = 'processing'
       AND session_id IS ?
       AND processed_at < datetime('now', ? || ' minutes')`
  ).run(owner(), `-${staleMinutes}`);
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

// A message nobody took in this long has no session left to take it.
const ORPHAN_MAX_AGE_HOURS = 24;

/**
 * Start-up: put this session's half-done messages back in the queue, and
 * expire the ones it left too long ago.
 *
 * Owner, 2026-10-02: a console started with --new drained a benchmark task an
 * API client had sent five days earlier to another session, and ran it with
 * the API's automatic approval. A message belongs to the session it was sent
 * to and to the minutes after it was sent. Reminders (channel 'scheduler')
 * are kept: they are the operator's own schedule.
 *
 * That fix expired every message of ANOTHER session here, which was right
 * while one Flint ran at a time and wrong the day several did: each start
 * failed the live messages of the rest (2026-10-10). Another session's
 * message cannot be run by this instance any more (drain), so a start has no
 * reason to touch it. What a session that is gone left behind is expired by
 * age in cleanup().
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
       AND session_id IS ?
       AND created_at < datetime('now', ? || ' minutes')`
  ).run(sessionId ?? null, `-${LEFTOVER_MAX_AGE_MINUTES}`);
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
  // Whatever session it was for, a message still untaken after a day will not
  // be: its session ended, or never came back after a crash. The same for one
  // taken a day ago and never finished. Failed, not deleted, so it stays
  // readable for failedDays like any other failure. A waiting reminder is
  // kept whatever its age; one taken and abandoned is not.
  const age = `-${ORPHAN_MAX_AGE_HOURS}`;
  db.prepare(
    `UPDATE message_queue
     SET status = 'failed', result = 'expired: its session never took it', processed_at = datetime('now')
     WHERE (status = 'pending' AND channel != 'scheduler' AND created_at < datetime('now', ? || ' hours'))
        OR (status = 'processing' AND processed_at < datetime('now', ? || ' hours'))`
  ).run(age, age);
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
    `SELECT status, COUNT(*) as count FROM message_queue WHERE ${MINE} GROUP BY status`
  ).all(owner());
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
     WHERE status = 'pending' AND ${MINE}
     ORDER BY priority ASC, created_at ASC
     LIMIT ?`
  ).all(owner(), limit).map(row => ({
    ...row,
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
  }));
}

/**
 * Get one of this instance's messages by ID (for polling result). Another
 * session's id answers like an id nobody has: the API polls by id, and ids
 * are consecutive across every Flint on the machine.
 * @param {number} id
 * @returns {object|null}
 */
export function getMessage(id) {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM message_queue WHERE id = ? AND ${MINE}`).get(id, owner());
  if (!row) return null;
  return { ...row, metadata: row.metadata ? JSON.parse(row.metadata) : null };
}
