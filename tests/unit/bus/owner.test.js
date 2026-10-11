// Whose message it is (owner, 2026-10-10). Four Flints ran at once on
// one machine, all started by hand, all on one ~/.flint/tasks.db. A task sent
// over the API to the Flint on port 3002 (row 10433) was taken and run, with
// the API's automatic approval, by a third Flint on port 3001 where the owner
// was talking about something else. A pairing PIN typed into one console was
// run as a message by another. And each Flint that started expired the live
// messages of the others. An instance sees, takes, recovers and expires only
// what was sent to its own session. The real bus module, on a database of its
// own; two instances are played by switching the owner.
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("../../../src/logging/logger.js", () => ({
  createLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
}));

const A = "2026-10-11T00-43-50"; // the Flint the task was sent to
const B = "2026-10-10T23-23-14"; // the Flint that took it

let bus;
let db;
let me = null;

beforeAll(async () => {
  process.env.FLINT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "flint-bus-owner-"));
  bus = await import("../../../src/bus/index.js");
  db = (await import("../../../src/tasks/db.js")).getDb();
  bus.setOwner(() => me);
});

beforeEach(() => {
  db.prepare("DELETE FROM message_queue").run();
  me = null;
});

const as = (session) => { me = session; };
const row = (id) => db.prepare("SELECT status, result, session_id FROM message_queue WHERE id = ?").get(id);

// A row as another run left it: its own age, status and session.
function leftover({ channel = "api", session, status = "pending", ageMinutes }) {
  const r = db.prepare(
    `INSERT INTO message_queue (channel, content, priority, source, session_id, status, created_at, processed_at)
     VALUES (?, 'left', 1, 'api@127.0.0.1', ?, ?, datetime('now', ?), ?)`
  ).run(channel, session, status, `-${ageMinutes} minutes`, null);
  if (status === "processing") {
    db.prepare(`UPDATE message_queue SET processed_at = datetime('now', ?) WHERE id = ?`)
      .run(`-${ageMinutes} minutes`, r.lastInsertRowid);
  }
  return Number(r.lastInsertRowid);
}

describe("a message belongs to the session it was sent to", () => {
  it("is not taken, listed, counted or shown by another instance", () => {
    as(A);
    const { id } = bus.push({ channel: "api", content: "write the article", priority: bus.PRIORITY.API, source: "flint-laptop@127.0.0.1", sessionId: A });

    as(B);
    expect(bus.drain()).toBeNull();
    expect(bus.pending()).toEqual([]);
    expect(bus.stats().pending).toBe(0);
    // The same answer as for an id nobody ever had.
    expect(bus.getMessage(id)).toBeNull();
    expect(row(id).status).toBe("pending");

    as(A);
    expect(bus.stats().pending).toBe(1);
    expect(bus.getMessage(id).content).toBe("write the article");
    expect(bus.drain().id).toBe(id);
  });

  it("is stamped with the instance that pushed it when the caller names no session", () => {
    // /later, the self-continue of an autonomous run and channel plugins push
    // without a session; such a row had no owner and anyone could run it.
    as(A);
    const { id } = bus.push({ channel: "user", content: "after this turn", priority: bus.PRIORITY.USER, source: "later" });
    expect(row(id).session_id).toBe(A);

    as(B);
    expect(bus.drain()).toBeNull();
  });
});

describe("a start touches only its own messages", () => {
  it("leaves another running instance's messages exactly as they were", () => {
    const waiting = leftover({ session: A, ageMinutes: 1 });
    // A long turn: taken half an hour ago and still being worked on.
    const inWork = leftover({ session: A, status: "processing", ageMinutes: 30 });

    as(B);
    const r = bus.prepareQueueAtStart({ sessionId: B });

    expect(r).toEqual({ recovered: 0, expired: 0 });
    expect(row(waiting).status).toBe("pending");
    expect(row(inWork).status).toBe("processing");
  });

  it("still takes back its own half-done message and expires its own stale one", () => {
    const crashed = leftover({ session: A, status: "processing", ageMinutes: 6 });
    const stale = leftover({ session: A, ageMinutes: 60 });

    as(A);
    const r = bus.prepareQueueAtStart({ sessionId: A });

    expect(r).toEqual({ recovered: 1, expired: 1 });
    expect(row(crashed).status).toBe("pending");
    expect(row(stale).status).toBe("failed");
    expect(row(stale).result).toMatch(/expired/);
  });
});

describe("messages of a session that is gone", () => {
  it("are never run, and are expired by age", () => {
    const fresh = leftover({ session: "2026-10-09T10-00-00", ageMinutes: 30 });
    const old = leftover({ session: "2026-10-08T10-00-00", ageMinutes: 2 * 24 * 60 });

    as(B);
    expect(bus.drain()).toBeNull();
    bus.cleanup();

    // Its session may still be running a long turn; a day is not up.
    expect(row(fresh).status).toBe("pending");
    expect(row(old).status).toBe("failed");
    expect(row(old).result).toMatch(/expired/);
  });
});

describe("a reminder", () => {
  it("is the operator's, not a session's: one instance takes it, once, and then owns it", () => {
    as(A);
    const { id } = bus.push({ channel: "scheduler", content: "call the bank", priority: bus.PRIORITY.TASK, source: "schedule" });

    as(B);
    expect(bus.stats().pending).toBe(1);
    expect(bus.drain().id).toBe(id);
    expect(bus.drain()).toBeNull();
    expect(row(id).session_id).toBe(B);

    // Taken by B: a start of A must not put it back in the queue to run again.
    db.prepare(`UPDATE message_queue SET processed_at = datetime('now', '-30 minutes') WHERE id = ?`).run(id);
    as(A);
    expect(bus.prepareQueueAtStart({ sessionId: A })).toEqual({ recovered: 0, expired: 0 });
    expect(row(id).status).toBe("processing");
  });

  it("left by a run that ended is still there for the next start, whatever its age", () => {
    const reminder = leftover({ channel: "scheduler", session: "2026-10-08T10-00-00", ageMinutes: 2 * 24 * 60 });

    as(B);
    bus.prepareQueueAtStart({ sessionId: B });
    bus.cleanup();

    expect(row(reminder).status).toBe("pending");
    expect(bus.drain().id).toBe(reminder);
  });
});
