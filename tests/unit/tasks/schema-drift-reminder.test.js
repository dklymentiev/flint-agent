// Regression test for v1.0.0 bug: schema drift blocks standalone reminders
//
// Found 2026-04-12 on first live user interaction after v1.0.0 ship.
// User typed "запланируй напоминание через 5 минут", Flint called add_task
// without goal_id, and got:
//     Error: NOT NULL constraint failed: tasks.goal_id
//
// Root cause:
//   - src/tasks/db.js line 40: `goal_id INTEGER REFERENCES goals(id)` — nullable
//   - live ~/.flint/tasks.db: `goal_id INTEGER NOT NULL REFERENCES goals(id)` — old schema
//   - migrate() uses CREATE TABLE IF NOT EXISTS which does NOT alter existing schema
//   - SQLite cannot DROP NOT NULL via ALTER TABLE — needs full rebuild
//
// Why 1296 unit tests + 143 benchmark tasks missed this:
//   - Unit tests always create fresh in-memory DBs from current source.
//     New DBs always have the correct (nullable) schema.
//   - Live benchmark (L1/L2/L4) has zero add_task-without-goal test cases.
//   - Real users upgrading from <v1.0.0 carry the old NOT NULL schema.
//
// This test documents the bug AND proves the fix is viable.
// After v1.0.1 lands the migrate() fix, the second half of this test passes
// via the real getDb() code path (add a follow-up test that does that).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";

// Old schema — exactly what ~/.flint/tasks.db contains on a user machine
// that was initialized before the NOT NULL constraint was removed.
// DO NOT change this to match current source. The whole point of this test
// is that the OLD schema exists in the wild and we have to migrate it.
const OLD_SCHEMA_SQL = `
  CREATE TABLE goals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    project TEXT DEFAULT 'default',
    status TEXT DEFAULT 'active' CHECK(status IN ('active', 'completed', 'abandoned')),
    session_id TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT
  );
  CREATE TABLE tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    goal_id INTEGER NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'in_progress', 'done', 'skipped')),
    priority INTEGER DEFAULT 0,
    result TEXT,
    next_run TEXT,
    repeat TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_tasks_goal ON tasks(goal_id);
  CREATE INDEX idx_tasks_status ON tasks(status);
`;

/**
 * Migration logic that v1.0.1 must add to src/tasks/db.js migrate().
 * This is the SQL-only description of what the fix has to do.
 * Exported here so the test can validate the logic independently of
 * where it lands in the source tree.
 */
function migrateDropGoalIdNotNull(db) {
  // Check if tasks.goal_id has NOT NULL
  const tableSql = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'")
    .get();
  if (!tableSql || !/goal_id\s+INTEGER\s+NOT NULL/i.test(tableSql.sql)) {
    return; // already migrated or fresh DB, nothing to do
  }

  // SQLite has no ALTER COLUMN. We must rebuild the table.
  db.exec("BEGIN");
  try {
    // 1. Save any extra columns the live DB may have (added via ALTER TABLE ADD COLUMN)
    const columns = db.prepare("PRAGMA table_info(tasks)").all();
    const columnNames = columns.map((c) => c.name);
    const columnList = columnNames.join(", ");

    // 2. Create new tasks table with nullable goal_id but otherwise identical
    //    (keep the same set of columns — this is the minimal behavior change)
    db.exec(`
      CREATE TABLE tasks_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        goal_id INTEGER REFERENCES goals(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        description TEXT,
        status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'in_progress', 'done', 'skipped')),
        priority INTEGER DEFAULT 0,
        result TEXT,
        next_run TEXT,
        repeat TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);

    // Dynamically add any extra columns (assignee, agent_port, scope, parent_task_id, daily_focus)
    // that might have been added to live DB via later ALTER TABLE ADD COLUMN migrations.
    const knownCols = new Set([
      "id", "goal_id", "title", "description", "status", "priority",
      "result", "next_run", "repeat", "created_at", "updated_at",
    ]);
    for (const col of columns) {
      if (knownCols.has(col.name)) continue;
      // Preserve column type and default, don't invent new constraints
      const typeClause = col.type || "TEXT";
      const defaultClause = col.dflt_value != null ? ` DEFAULT ${col.dflt_value}` : "";
      db.exec(`ALTER TABLE tasks_new ADD COLUMN ${col.name} ${typeClause}${defaultClause}`);
    }

    // 3. Copy all rows from old tasks table
    db.exec(`INSERT INTO tasks_new (${columnList}) SELECT ${columnList} FROM tasks`);

    // 4. Drop old table, rename new one into place
    db.exec("DROP TABLE tasks");
    db.exec("ALTER TABLE tasks_new RENAME TO tasks");

    // 5. Recreate indexes (they were on the old table)
    db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_goal ON tasks(goal_id)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)");

    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

describe("schema drift: tasks.goal_id NOT NULL blocks standalone reminders", () => {
  let db;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(OLD_SCHEMA_SQL);
  });

  afterEach(() => {
    db.close();
  });

  it("documents the bug: insert without goal_id fails on old schema", () => {
    // This is exactly what happens to a v1.0.0 user typing 'запланируй напоминание'
    expect(() => {
      db.prepare("INSERT INTO tasks (title) VALUES (?)").run("remind me in 5 min");
    }).toThrow(/NOT NULL constraint failed: tasks\.goal_id/);
  });

  it("old schema rejects even an explicit null goal_id", () => {
    expect(() => {
      db.prepare("INSERT INTO tasks (goal_id, title) VALUES (?, ?)").run(null, "reminder");
    }).toThrow(/NOT NULL constraint failed: tasks\.goal_id/);
  });

  it("after migrateDropGoalIdNotNull: insert without goal_id succeeds", () => {
    migrateDropGoalIdNotNull(db);

    const info = db.prepare("PRAGMA table_info(tasks)").all();
    const goalIdCol = info.find((c) => c.name === "goal_id");
    expect(goalIdCol.notnull).toBe(0);

    const result = db.prepare("INSERT INTO tasks (title) VALUES (?)").run("remind me in 5 min");
    expect(result.changes).toBe(1);

    const row = db.prepare("SELECT id, goal_id, title FROM tasks WHERE id = ?").get(result.lastInsertRowid);
    expect(row.goal_id).toBe(null);
    expect(row.title).toBe("remind me in 5 min");
  });

  it("migration preserves existing rows", () => {
    // Put some real data into the old schema
    const goal = db.prepare("INSERT INTO goals (title) VALUES (?)").run("existing goal");
    db.prepare("INSERT INTO tasks (goal_id, title) VALUES (?, ?)").run(goal.lastInsertRowid, "task 1");
    db.prepare("INSERT INTO tasks (goal_id, title) VALUES (?, ?)").run(goal.lastInsertRowid, "task 2");
    const before = db.prepare("SELECT COUNT(*) as n FROM tasks").get().n;
    expect(before).toBe(2);

    migrateDropGoalIdNotNull(db);

    const after = db.prepare("SELECT COUNT(*) as n FROM tasks").get().n;
    expect(after).toBe(2);

    const rows = db.prepare("SELECT goal_id, title FROM tasks ORDER BY id").all();
    expect(rows).toEqual([
      { goal_id: goal.lastInsertRowid, title: "task 1" },
      { goal_id: goal.lastInsertRowid, title: "task 2" },
    ]);
  });

  it("migration is idempotent — safe to run on already-migrated schema", () => {
    migrateDropGoalIdNotNull(db);
    // Second run should be a no-op
    expect(() => migrateDropGoalIdNotNull(db)).not.toThrow();

    const info = db.prepare("PRAGMA table_info(tasks)").all();
    const goalIdCol = info.find((c) => c.name === "goal_id");
    expect(goalIdCol.notnull).toBe(0);
  });

  it("migration handles extra columns from later ALTER TABLE ADD COLUMN", () => {
    // Simulate the real live DB which has been upgraded through multiple versions
    db.exec("ALTER TABLE tasks ADD COLUMN assignee TEXT");
    db.exec("ALTER TABLE tasks ADD COLUMN agent_port INTEGER");
    db.exec("ALTER TABLE tasks ADD COLUMN scope TEXT DEFAULT 'session'");
    db.exec("ALTER TABLE tasks ADD COLUMN parent_task_id INTEGER REFERENCES tasks(id)");
    db.exec("ALTER TABLE tasks ADD COLUMN daily_focus TEXT");

    // Insert with all the extra fields
    const goal = db.prepare("INSERT INTO goals (title) VALUES (?)").run("g");
    db.prepare(
      "INSERT INTO tasks (goal_id, title, scope, daily_focus) VALUES (?, ?, ?, ?)"
    ).run(goal.lastInsertRowid, "complex task", "project", "2026-04-12");

    migrateDropGoalIdNotNull(db);

    // All columns should still exist
    const info = db.prepare("PRAGMA table_info(tasks)").all();
    const colNames = info.map((c) => c.name).sort();
    expect(colNames).toContain("assignee");
    expect(colNames).toContain("agent_port");
    expect(colNames).toContain("scope");
    expect(colNames).toContain("parent_task_id");
    expect(colNames).toContain("daily_focus");

    // Data preserved
    const row = db.prepare("SELECT title, scope, daily_focus FROM tasks").get();
    expect(row.title).toBe("complex task");
    expect(row.scope).toBe("project");
    expect(row.daily_focus).toBe("2026-04-12");

    // And reminder without goal now works
    const result = db.prepare("INSERT INTO tasks (title) VALUES (?)").run("reminder");
    expect(result.changes).toBe(1);
  });
});
