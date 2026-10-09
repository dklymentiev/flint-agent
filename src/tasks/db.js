// SQLite persistent task database for Flint
// File: ~/.flint/tasks.db

import Database from "better-sqlite3";
import path from "node:path";
import { mkdirSync } from "node:fs";
import { homeStateDir } from "../data-dir.js";

// FLINT_DATA_DIR moves this database too, like sessions/ and memory/.
// It holds the message bus, and the bus recovers stale "processing" messages
// on startup: a bench instance killed mid-turn left its prompt here, and the
// next instance, started for a different task, picked it up and worked on it
// for fifteen minutes (SWE pilot, 2026-09-26). A subject with its own data
// dir must not share a queue with anyone.
const FLINT_DIR = homeStateDir();
const DB_PATH = path.join(FLINT_DIR, "tasks.db");

/** Where the task and message-bus database lives, for isolation checks. */
export function tasksDbPath() {
  return DB_PATH;
}

let db = null;

export function getDb() {
  if (db) return db;

  mkdirSync(FLINT_DIR, { recursive: true });
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  migrate(db);
  return db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS goals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      project TEXT DEFAULT 'default',
      status TEXT DEFAULT 'active' CHECK(status IN ('active', 'completed', 'abandoned')),
      session_id TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS tasks (
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
    );

    CREATE TABLE IF NOT EXISTS task_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      role TEXT DEFAULT 'related' CHECK(role IN ('created', 'modified', 'related')),
      added_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS task_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      note TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_goal ON tasks(goal_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_goals_status ON goals(status);
    CREATE INDEX IF NOT EXISTS idx_goals_project ON goals(project);
  `);

  // Migration: add next_run and repeat columns to existing tables
  try { db.exec("ALTER TABLE tasks ADD COLUMN next_run TEXT"); } catch {}
  try { db.exec("ALTER TABLE tasks ADD COLUMN repeat TEXT"); } catch {}

  // Migration: add assignee and agent_port for task-driven child agents
  try { db.exec("ALTER TABLE tasks ADD COLUMN assignee TEXT"); } catch {}
  try { db.exec("ALTER TABLE tasks ADD COLUMN agent_port INTEGER"); } catch {}

  // Migration: scope (session/project/global) and parent_task_id
  try { db.exec("ALTER TABLE tasks ADD COLUMN scope TEXT DEFAULT 'session'"); } catch {}
  try { db.exec("ALTER TABLE tasks ADD COLUMN parent_task_id INTEGER REFERENCES tasks(id)"); } catch {}

  // Migration: daily_focus date for day planning
  try { db.exec("ALTER TABLE tasks ADD COLUMN daily_focus TEXT"); } catch {}

  // Index on next_run (after migration ensures column exists)
  db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_next_run ON tasks(next_run)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_scope ON tasks(scope)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_task_id)");

  // Migration: drop NOT NULL on tasks.goal_id for standalone reminders (#v1.0.1)
  // Old schema had goal_id INTEGER NOT NULL — blocks add_task without a goal.
  // SQLite can't ALTER COLUMN, so we rebuild the table if NOT NULL is detected.
  try {
    const tableSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'").get();
    if (tableSql && /goal_id\s+INTEGER\s+NOT NULL/i.test(tableSql.sql)) {
      const columns = db.prepare("PRAGMA table_info(tasks)").all();
      const columnList = columns.map(c => c.name).join(", ");
      db.exec("BEGIN");
      db.exec(`CREATE TABLE tasks_new (
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
      )`);
      // Add any extra columns from prior ALTER TABLE migrations
      const knownCols = new Set(["id","goal_id","title","description","status","priority","result","next_run","repeat","created_at","updated_at"]);
      for (const col of columns) {
        if (knownCols.has(col.name)) continue;
        const typeDef = col.type || "TEXT";
        const dflt = col.dflt_value != null ? ` DEFAULT ${col.dflt_value}` : "";
        try { db.exec(`ALTER TABLE tasks_new ADD COLUMN ${col.name} ${typeDef}${dflt}`); } catch {}
      }
      db.exec(`INSERT INTO tasks_new (${columnList}) SELECT ${columnList} FROM tasks`);
      db.exec("DROP TABLE tasks");
      db.exec("ALTER TABLE tasks_new RENAME TO tasks");
      db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_goal ON tasks(goal_id)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)");
      db.exec("COMMIT");
    }
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch {}
  }

  // Sessions registry: track session lifecycle for GC
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      created_at TEXT DEFAULT (datetime('now')),
      last_updated TEXT DEFAULT (datetime('now')),
      focused_goal_id INTEGER REFERENCES goals(id)
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(last_updated);
  `);

  // Message Bus: unified priority queue for all input channels
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

export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}
