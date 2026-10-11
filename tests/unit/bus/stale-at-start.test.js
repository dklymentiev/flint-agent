// What a new start does with the queue a previous run left behind (owner,
// 2026-10-02). A console started with --new drained a benchmark task an API
// client had sent five days earlier to another session, and ran it with the
// API's automatic approval. Leftovers from another session, or too old to have
// anyone still waiting for them, are expired, not run. The real bus module, on
// a database of its own.
import { describe, it, expect, vi, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("../../../src/logging/logger.js", () => ({
  createLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
}));

let bus;
let db;

beforeAll(async () => {
  process.env.FLINT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "flint-stale-queue-"));
  bus = await import("../../../src/bus/index.js");
  db = (await import("../../../src/tasks/db.js")).getDb();
  bus.setOwner(() => current);
});

// The session the instance under test is running.
let current = null;

// A row as an earlier run left it: its own created_at, status and session.
function leftover({ channel, source, session, status = "pending", ageMinutes }) {
  const r = db.prepare(
    `INSERT INTO message_queue (channel, content, priority, source, session_id, status, created_at, processed_at)
     VALUES (?, ?, 1, ?, ?, ?, datetime('now', ?), ?)`
  ).run(channel, `${channel} from ${session} ${ageMinutes} min ago`, source, session, status,
    `-${ageMinutes} minutes`, status === "processing" ? null : null);
  if (status === "processing") {
    db.prepare(`UPDATE message_queue SET processed_at = datetime('now', ?) WHERE id = ?`)
      .run(`-${ageMinutes} minutes`, r.lastInsertRowid);
  }
  return Number(r.lastInsertRowid);
}

const statusOf = (id) => db.prepare("SELECT status, result FROM message_queue WHERE id = ?").get(id);

describe("the queue at start", () => {
  it("expires what an earlier run left, keeps what belongs to this one", () => {
    const now = "2026-10-02T22-56-34";
    const benchTask = leftover({ channel: "api", source: "api@127.0.0.1", session: "2026-09-27T00-19-51", status: "processing", ageMinutes: 5 * 24 * 60 });
    const testJunk = leftover({ channel: "api", source: "api@127.0.0.1", session: "test-session", ageMinutes: 3 * 24 * 60 });
    const otherSessionRecent = leftover({ channel: "agent", source: "agent:3011", session: "2026-10-02T20-00-00", ageMinutes: 1 });
    const oldNoSession = leftover({ channel: "api", source: "api@127.0.0.1", session: null, ageMinutes: 60 });
    // Typed just before /restart, which continues the same session.
    const queuedBeforeRestart = leftover({ channel: "user", source: "tui", session: now, ageMinutes: 1 });
    const reminder = leftover({ channel: "scheduler", source: "schedule", session: null, ageMinutes: 2 * 24 * 60 });

    current = now;
    const r = bus.prepareQueueAtStart({ sessionId: now });

    // Since 1.14.9 a start does not touch another session's messages at all:
    // that session may be running in the next window. They are not run here
    // because drain never hands them to this instance, and what a session that
    // is gone left behind is expired by age.
    expect(r.expired).toBe(0);
    expect(statusOf(otherSessionRecent).status).toBe("pending");
    expect(statusOf(queuedBeforeRestart).status).toBe("pending");
    expect(statusOf(reminder).status).toBe("pending");

    const drained = [];
    let m;
    while ((m = bus.drain())) { drained.push(m.id); bus.complete(m.id, "test"); }
    expect(drained.sort()).toEqual([queuedBeforeRestart, reminder].sort());

    bus.cleanup();
    for (const id of [benchTask, testJunk]) {
      expect(statusOf(id).status).toBe("failed");
      expect(statusOf(id).result).toMatch(/expired/);
    }
    // An hour and a minute old: a day is not up, and nobody may run them.
    expect(statusOf(oldNoSession).status).toBe("pending");
    expect(statusOf(otherSessionRecent).status).toBe("pending");
  });

  it("still recovers this session's message that a crash left half done", () => {
    const now = "2026-10-03T08-00-00";
    current = now;
    const crashed = leftover({ channel: "user", source: "tui", session: now, status: "processing", ageMinutes: 6 });
    const r = bus.prepareQueueAtStart({ sessionId: now });
    expect(r.recovered).toBeGreaterThanOrEqual(1);
    expect(statusOf(crashed).status).toBe("pending");
  });
});
