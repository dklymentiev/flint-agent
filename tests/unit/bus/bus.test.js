// Tests for Message Bus
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Standalone test DB (same schema as db.js migration)
let db;
let dbPath;

function createSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS message_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel TEXT NOT NULL,
      content TEXT NOT NULL,
      priority INTEGER DEFAULT 5,
      source TEXT,
      metadata TEXT,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'processing', 'done', 'failed')),
      session_id TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      processed_at TEXT,
      result TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_queue_drain ON message_queue(status, priority, created_at);
    CREATE INDEX IF NOT EXISTS idx_queue_cleanup ON message_queue(status, processed_at);
  `);
}

// Direct DB operations (mirror bus/index.js logic for isolated testing)
function push({ channel, content, priority = 5, source, metadata, sessionId }) {
  const result = db.prepare(
    `INSERT INTO message_queue (channel, content, priority, source, metadata, session_id)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(channel, content, priority, source || null, metadata ? JSON.stringify(metadata) : null, sessionId || null);
  return { id: Number(result.lastInsertRowid) };
}

function drain() {
  const msg = db.prepare(
    `SELECT * FROM message_queue WHERE status = 'pending' ORDER BY priority ASC, created_at ASC LIMIT 1`
  ).get();
  if (!msg) return null;
  db.prepare(`UPDATE message_queue SET status = 'processing', processed_at = datetime('now') WHERE id = ?`).run(msg.id);
  return { ...msg, status: "processing", metadata: msg.metadata ? JSON.parse(msg.metadata) : null };
}

function complete(id, result) {
  db.prepare(`UPDATE message_queue SET status = 'done', result = ?, processed_at = datetime('now') WHERE id = ?`).run(result || null, id);
}

function fail(id, error) {
  db.prepare(`UPDATE message_queue SET status = 'failed', result = ?, processed_at = datetime('now') WHERE id = ?`).run(error || "unknown error", id);
}

function recover(staleMinutes = 5) {
  const result = db.prepare(
    `UPDATE message_queue SET status = 'pending', processed_at = NULL
     WHERE status = 'processing' AND processed_at < datetime('now', ? || ' minutes')`
  ).run(`-${staleMinutes}`);
  return result.changes;
}

function stats() {
  const rows = db.prepare(`SELECT status, COUNT(*) as count FROM message_queue GROUP BY status`).all();
  const s = { pending: 0, processing: 0, done: 0, failed: 0, total: 0 };
  for (const row of rows) { s[row.status] = row.count; s.total += row.count; }
  return s;
}

function pending(limit = 50) {
  return db.prepare(
    `SELECT * FROM message_queue WHERE status = 'pending' ORDER BY priority ASC, created_at ASC LIMIT ?`
  ).all(limit);
}

function getMessage(id) {
  return db.prepare("SELECT * FROM message_queue WHERE id = ?").get(id) || null;
}

beforeEach(() => {
  dbPath = path.join(os.tmpdir(), `bus-test-${Date.now()}.db`);
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  createSchema();
});

afterEach(() => {
  db.close();
  try { fs.unlinkSync(dbPath); } catch {}
  try { fs.unlinkSync(dbPath + "-wal"); } catch {}
  try { fs.unlinkSync(dbPath + "-shm"); } catch {}
});

describe("Message Bus", () => {
  describe("push", () => {
    it("inserts a message with all fields", () => {
      const { id } = push({ channel: "user", content: "hello", priority: 0, source: "tui", metadata: { key: "val" }, sessionId: "s1" });
      const msg = getMessage(id);
      expect(msg.channel).toBe("user");
      expect(msg.content).toBe("hello");
      expect(msg.priority).toBe(0);
      expect(msg.source).toBe("tui");
      expect(JSON.parse(msg.metadata)).toEqual({ key: "val" });
      expect(msg.session_id).toBe("s1");
      expect(msg.status).toBe("pending");
    });

    it("defaults priority to 5", () => {
      const { id } = push({ channel: "system", content: "ping" });
      expect(getMessage(id).priority).toBe(5);
    });

    it("assigns sequential IDs", () => {
      const a = push({ channel: "user", content: "a" });
      const b = push({ channel: "user", content: "b" });
      expect(b.id).toBe(a.id + 1);
    });
  });

  describe("drain", () => {
    it("returns null on empty queue", () => {
      expect(drain()).toBeNull();
    });

    it("returns highest priority message first", () => {
      push({ channel: "system", content: "low", priority: 5 });
      push({ channel: "user", content: "high", priority: 0 });
      push({ channel: "api", content: "mid", priority: 1 });

      const msg = drain();
      expect(msg.content).toBe("high");
      expect(msg.priority).toBe(0);
      expect(msg.status).toBe("processing");
    });

    it("FIFO within same priority", () => {
      push({ channel: "user", content: "first", priority: 0 });
      push({ channel: "user", content: "second", priority: 0 });

      expect(drain().content).toBe("first");
      expect(drain().content).toBe("second");
    });

    it("marks message as processing", () => {
      const { id } = push({ channel: "user", content: "test" });
      drain();
      const msg = getMessage(id);
      expect(msg.status).toBe("processing");
      expect(msg.processed_at).toBeTruthy();
    });

    it("does not return processing messages", () => {
      push({ channel: "user", content: "a" });
      drain(); // a is now processing
      expect(drain()).toBeNull(); // nothing else pending
    });
  });

  describe("complete / fail", () => {
    it("marks message as done with result", () => {
      const { id } = push({ channel: "user", content: "test" });
      drain();
      complete(id, "answer: 42");
      const msg = getMessage(id);
      expect(msg.status).toBe("done");
      expect(msg.result).toBe("answer: 42");
    });

    it("marks message as failed with error", () => {
      const { id } = push({ channel: "api", content: "test" });
      drain();
      fail(id, "API timeout");
      const msg = getMessage(id);
      expect(msg.status).toBe("failed");
      expect(msg.result).toBe("API timeout");
    });
  });

  describe("recover", () => {
    it("resets stale processing messages to pending", () => {
      const { id } = push({ channel: "user", content: "stuck" });
      drain(); // now processing
      // Simulate stale: set processed_at far in the past
      db.prepare("UPDATE message_queue SET processed_at = datetime('now', '-10 minutes') WHERE id = ?").run(id);
      const count = recover(5);
      expect(count).toBe(1);
      expect(getMessage(id).status).toBe("pending");
    });

    it("does not reset fresh processing messages", () => {
      const { id } = push({ channel: "user", content: "fresh" });
      drain(); // now processing, processed_at = now
      const count = recover(5);
      expect(count).toBe(0);
      expect(getMessage(id).status).toBe("processing");
    });

    it("returns 0 when nothing to recover", () => {
      expect(recover()).toBe(0);
    });
  });

  describe("stats", () => {
    it("returns zeroes on empty queue", () => {
      const s = stats();
      expect(s).toEqual({ pending: 0, processing: 0, done: 0, failed: 0, total: 0 });
    });

    it("counts by status correctly", () => {
      push({ channel: "user", content: "a" });
      push({ channel: "user", content: "b" });
      push({ channel: "user", content: "c" });
      push({ channel: "user", content: "d" });

      const m1 = drain(); // a → processing
      complete(m1.id, "ok"); // a → done
      const m2 = drain(); // b → processing
      fail(m2.id, "err"); // b → failed
      drain(); // c → processing

      // d=pending, c=processing, a=done, b=failed
      const s = stats();
      expect(s.pending).toBe(1);
      expect(s.processing).toBe(1);
      expect(s.done).toBe(1);
      expect(s.failed).toBe(1);
      expect(s.total).toBe(4);
    });
  });

  describe("pending", () => {
    it("returns pending messages ordered by priority", () => {
      push({ channel: "system", content: "low", priority: 5 });
      push({ channel: "user", content: "high", priority: 0 });
      push({ channel: "agent", content: "mid", priority: 2 });

      const msgs = pending();
      expect(msgs).toHaveLength(3);
      expect(msgs[0].content).toBe("high");
      expect(msgs[1].content).toBe("mid");
      expect(msgs[2].content).toBe("low");
    });

    it("respects limit", () => {
      for (let i = 0; i < 10; i++) push({ channel: "user", content: `msg${i}` });
      expect(pending(3)).toHaveLength(3);
    });
  });

  describe("full lifecycle", () => {
    it("push → drain → complete cycle", () => {
      const { id } = push({ channel: "user", content: "hello world", priority: 0, source: "tui" });

      const msg = drain();
      expect(msg.id).toBe(id);
      expect(msg.channel).toBe("user");
      expect(msg.content).toBe("hello world");

      complete(id, "Hello! How can I help?");

      const final = getMessage(id);
      expect(final.status).toBe("done");
      expect(final.result).toBe("Hello! How can I help?");
    });

    it("multi-channel priority ordering", () => {
      push({ channel: "system", content: "heartbeat", priority: 5 });
      push({ channel: "scheduler", content: "reminder", priority: 3 });
      push({ channel: "user", content: "urgent", priority: 0 });
      push({ channel: "api", content: "request", priority: 1 });
      push({ channel: "agent", content: "child result", priority: 2 });

      expect(drain().channel).toBe("user");      // 0
      expect(drain().channel).toBe("api");        // 1
      expect(drain().channel).toBe("agent");      // 2
      expect(drain().channel).toBe("scheduler");  // 3
      expect(drain().channel).toBe("system");     // 5
      expect(drain()).toBeNull();                  // empty
    });

    it("crash recovery → re-drain", () => {
      push({ channel: "user", content: "will crash" });
      drain(); // processing
      // Simulate crash: set stale timestamp
      db.prepare("UPDATE message_queue SET processed_at = datetime('now', '-10 minutes') WHERE status = 'processing'").run();

      // Startup recovery
      recover(5);

      // Re-drain should return the same message
      const msg = drain();
      expect(msg.content).toBe("will crash");
      expect(msg.status).toBe("processing");
    });
  });
});
