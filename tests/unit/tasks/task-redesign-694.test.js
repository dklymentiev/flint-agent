// Tests for task system redesign
// Validates: sessions, multi-goal, focused goal, scope, task_stats

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

let db;
let tmpDir;

function migrate(db) {
  db.pragma("foreign_keys = ON");
  // A scratch database: no fsync per row. With it, inserting a few hundred
  // rows took over the 10 s test timeout on the Windows CI runners (2026-10-02).
  db.pragma("synchronous = OFF");
  db.pragma("journal_mode = MEMORY");
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
      assignee TEXT,
      agent_port INTEGER,
      scope TEXT DEFAULT 'session',
      parent_task_id INTEGER REFERENCES tasks(id),
      daily_focus TEXT,
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
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      created_at TEXT DEFAULT (datetime('now')),
      last_updated TEXT DEFAULT (datetime('now')),
      focused_goal_id INTEGER REFERENCES goals(id)
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_goal ON tasks(goal_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_scope ON tasks(scope);
    CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_task_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(last_updated);
  `);
}

// Helper: direct DB operations (mirroring queries.js logic)
function createGoal(title, project = "default", sessionId = null) {
  const r = db.prepare("INSERT INTO goals (title, project, session_id) VALUES (?, ?, ?)").run(title, project, sessionId);
  return db.prepare("SELECT * FROM goals WHERE id = ?").get(r.lastInsertRowid);
}

function createTask(goalId, title, priority = 0, scope = "session") {
  const r = db.prepare("INSERT INTO tasks (goal_id, title, priority, scope) VALUES (?, ?, ?, ?)").run(goalId, title, priority, scope);
  return db.prepare("SELECT * FROM tasks WHERE id = ?").get(r.lastInsertRowid);
}

function touchSession(sessionId) {
  const existing = db.prepare("SELECT id FROM sessions WHERE id = ?").get(sessionId);
  if (existing) {
    db.prepare("UPDATE sessions SET last_updated = datetime('now') WHERE id = ?").run(sessionId);
  } else {
    db.prepare("INSERT INTO sessions (id) VALUES (?)").run(sessionId);
  }
}

function setFocusedGoal(sessionId, goalId) {
  touchSession(sessionId);
  db.prepare("UPDATE sessions SET focused_goal_id = ? WHERE id = ?").run(goalId, sessionId);
}

function getFocusedGoal(sessionId) {
  const session = db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId);
  if (!session || !session.focused_goal_id) return null;
  const goal = db.prepare("SELECT * FROM goals WHERE id = ?").get(session.focused_goal_id);
  return goal && goal.status === "active" ? goal : null;
}

function getActiveGoals() {
  return db.prepare("SELECT * FROM goals WHERE status = 'active' ORDER BY created_at DESC").all();
}

function getTaskStats(goalId) {
  return db.prepare(`
    SELECT COUNT(*) as total,
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
      SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as in_progress,
      SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) as done,
      SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) as skipped
    FROM tasks WHERE goal_id = ? AND parent_task_id IS NULL
  `).get(goalId);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "flint-test-694-"));
  db = new Database(path.join(tmpDir, "tasks.db"));
  migrate(db);
});

afterEach(() => {
  if (db) db.close();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("Sessions", () => {
  it("creates and touches session", () => {
    touchSession("sess-1");
    const s = db.prepare("SELECT * FROM sessions WHERE id = ?").get("sess-1");
    expect(s).toBeTruthy();
    expect(s.id).toBe("sess-1");
  });

  it("touch updates last_updated", () => {
    touchSession("sess-1");
    const s1 = db.prepare("SELECT * FROM sessions WHERE id = ?").get("sess-1");
    // Touch again
    touchSession("sess-1");
    const s2 = db.prepare("SELECT * FROM sessions WHERE id = ?").get("sess-1");
    expect(s2.last_updated).toBeTruthy();
  });
});

describe("Multi-goal", () => {
  it("multiple goals can be active simultaneously", () => {
    const g1 = createGoal("Landing page", "screenbox", "sess-1");
    const g2 = createGoal("CI/CD setup", "flint", "sess-1");
    const active = getActiveGoals();
    expect(active.length).toBe(2);
  });

  it("focused goal is preferred over most recent", () => {
    const g1 = createGoal("First goal", "default", "sess-1");
    const g2 = createGoal("Second goal", "default", "sess-1");
    touchSession("sess-1");

    // Without focus — most recent (g2) would be returned by getActiveGoal
    // With focus on g1 — g1 is returned
    setFocusedGoal("sess-1", g1.id);
    const focused = getFocusedGoal("sess-1");
    expect(focused.id).toBe(g1.id);
    expect(focused.title).toBe("First goal");
  });

  it("focus returns null for completed goal", () => {
    const g = createGoal("Done goal", "default", "sess-1");
    touchSession("sess-1");
    setFocusedGoal("sess-1", g.id);
    db.prepare("UPDATE goals SET status = 'completed' WHERE id = ?").run(g.id);
    const focused = getFocusedGoal("sess-1");
    expect(focused).toBeNull();
  });

  it("create_plan does not abandon previous goals", () => {
    const g1 = createGoal("Goal A", "proj1", "sess-1");
    const g2 = createGoal("Goal B", "proj2", "sess-1");
    // Both should still be active
    const active = getActiveGoals();
    expect(active.length).toBe(2);
    expect(active.every(g => g.status === "active")).toBe(true);
  });
});

describe("Task scope", () => {
  it("tasks have default scope 'session'", () => {
    const g = createGoal("Test", "default", "sess-1");
    const t = createTask(g.id, "Task 1");
    expect(t.scope).toBe("session");
  });

  it("tasks can have project scope", () => {
    const g = createGoal("Test", "default", "sess-1");
    const t = createTask(g.id, "Task 1", 0, "project");
    expect(t.scope).toBe("project");
  });

  it("tasks can have global scope", () => {
    const g = createGoal("Test", "default", "sess-1");
    const t = createTask(g.id, "Daily check", 0, "global");
    expect(t.scope).toBe("global");
  });
});

describe("Task stats", () => {
  it("returns correct counts", () => {
    const g = createGoal("Test", "default", "sess-1");
    createTask(g.id, "Task 1");
    createTask(g.id, "Task 2");
    createTask(g.id, "Task 3");
    db.prepare("UPDATE tasks SET status = 'done' WHERE id = 1").run();
    db.prepare("UPDATE tasks SET status = 'in_progress' WHERE id = 2").run();

    const stats = getTaskStats(g.id);
    expect(stats.total).toBe(3);
    expect(stats.done).toBe(1);
    expect(stats.in_progress).toBe(1);
    expect(stats.pending).toBe(1);
  });
});

describe("parent_task_id column", () => {
  it("supports parent_task_id", () => {
    const g = createGoal("Auth", "default", "sess-1");
    const parent = createTask(g.id, "Setup auth");
    const child = db.prepare(
      "INSERT INTO tasks (goal_id, title, parent_task_id) VALUES (?, ?, ?)"
    ).run(g.id, "JWT tokens", parent.id);
    const fetched = db.prepare("SELECT * FROM tasks WHERE id = ?").get(child.lastInsertRowid);
    expect(fetched.parent_task_id).toBe(parent.id);
  });
});

describe("Day planning", () => {
  it("sets daily focus on a task", () => {
    const g = createGoal("Test");
    const t = createTask(g.id, "Task 1");
    const today = new Date().toISOString().slice(0, 10);
    db.prepare("UPDATE tasks SET daily_focus = ? WHERE id = ?").run(today, t.id);
    const fetched = db.prepare("SELECT * FROM tasks WHERE id = ?").get(t.id);
    expect(fetched.daily_focus).toBe(today);
  });

  it("getTodayTasks returns only today's focused tasks", () => {
    const g = createGoal("Test");
    const t1 = createTask(g.id, "Today task");
    const t2 = createTask(g.id, "Tomorrow task");
    const t3 = createTask(g.id, "No focus");

    const today = "2026-03-25";
    db.prepare("UPDATE tasks SET daily_focus = ? WHERE id = ?").run(today, t1.id);
    db.prepare("UPDATE tasks SET daily_focus = ? WHERE id = ?").run("2026-03-26", t2.id);

    const todayTasks = db.prepare(`
      SELECT t.*, g.title as goal_title, g.project
      FROM tasks t LEFT JOIN goals g ON t.goal_id = g.id
      WHERE t.daily_focus = ? AND t.status IN ('pending', 'in_progress')
      ORDER BY t.priority DESC, t.id ASC
    `).all(today);

    expect(todayTasks.length).toBe(1);
    expect(todayTasks[0].title).toBe("Today task");
  });

  it("completed tasks not shown in today", () => {
    const g = createGoal("Test");
    const t = createTask(g.id, "Done task");
    const today = "2026-03-25";
    db.prepare("UPDATE tasks SET daily_focus = ?, status = 'done' WHERE id = ?").run(today, t.id);

    const todayTasks = db.prepare(`
      SELECT * FROM tasks WHERE daily_focus = ? AND status IN ('pending', 'in_progress')
    `).all(today);
    expect(todayTasks.length).toBe(0);
  });
});

describe("Session GC", () => {
  it("orphans tasks from stale sessions", () => {
    // Create a session that's "old"
    db.prepare("INSERT INTO sessions (id, last_updated) VALUES (?, datetime('now', '-10 days'))").run("old-sess");
    const g = createGoal("Old goal", "default", "old-sess");
    createTask(g.id, "Old task");

    // Find stale sessions
    const stale = db.prepare("SELECT * FROM sessions WHERE last_updated < datetime('now', '-7 days')").all();
    expect(stale.length).toBe(1);
    expect(stale[0].id).toBe("old-sess");
  });

  it("active sessions are not GC'd", () => {
    touchSession("fresh-sess");
    const stale = db.prepare("SELECT * FROM sessions WHERE last_updated < datetime('now', '-7 days')").all();
    expect(stale.length).toBe(0);
  });
});

describe("Token budget", () => {
  it("plan block stays within budget", () => {
    const g = createGoal("Big goal");
    // Create many tasks
    for (let i = 0; i < 100; i++) {
      createTask(g.id, `Task ${i}: very long description that takes up space in the prompt injection`);
    }
    const tasks = db.prepare("SELECT * FROM tasks WHERE goal_id = ? AND parent_task_id IS NULL ORDER BY id").all(g.id);
    // Simulate formatPlanForPrompt
    const lines = [`[PLAN #${g.id}] Goal: ${g.title} (project: ${g.project})`];
    for (const t of tasks) {
      lines.push(`[#${t.id}] o ${t.title}`);
    }
    const planBlock = lines.join("\n");
    // Should be larger than budget
    expect(planBlock.length).toBeGreaterThan(3200);
    // Truncation would keep it under budget + truncation message
    const truncated = planBlock.slice(0, 3200) + "\n... (truncated)";
    expect(truncated.length).toBeLessThan(3300);
  });
});

describe("Global IDs", () => {
  it("task IDs are unique across goals", () => {
    const g1 = createGoal("Goal 1");
    const g2 = createGoal("Goal 2");
    const t1 = createTask(g1.id, "Task A");
    const t2 = createTask(g2.id, "Task B");
    expect(t1.id).not.toBe(t2.id);
  });
});

describe("Subtasks", () => {
  function createSubtask(parentId, title) {
    const parent = db.prepare("SELECT * FROM tasks WHERE id = ?").get(parentId);
    const r = db.prepare(
      "INSERT INTO tasks (goal_id, title, parent_task_id, scope) VALUES (?, ?, ?, ?)"
    ).run(parent.goal_id, title, parentId, parent.scope || "session");
    return db.prepare("SELECT * FROM tasks WHERE id = ?").get(r.lastInsertRowid);
  }

  function getSubtasks(parentId) {
    return db.prepare("SELECT * FROM tasks WHERE parent_task_id = ? ORDER BY id ASC").all(parentId);
  }

  it("creates subtasks linked to parent", () => {
    const g = createGoal("Auth", "default", "sess-1");
    const parent = createTask(g.id, "Setup auth");
    const sub1 = createSubtask(parent.id, "JWT tokens");
    const sub2 = createSubtask(parent.id, "Middleware");

    expect(sub1.parent_task_id).toBe(parent.id);
    expect(sub2.parent_task_id).toBe(parent.id);
    expect(sub1.goal_id).toBe(g.id);
  });

  it("getSubtasks returns only children of parent", () => {
    const g = createGoal("Test");
    const t1 = createTask(g.id, "Task 1");
    const t2 = createTask(g.id, "Task 2");
    createSubtask(t1.id, "Sub A");
    createSubtask(t1.id, "Sub B");
    createSubtask(t2.id, "Sub C");

    const subs1 = getSubtasks(t1.id);
    const subs2 = getSubtasks(t2.id);
    expect(subs1.length).toBe(2);
    expect(subs2.length).toBe(1);
  });

  it("subtask inherits scope from parent", () => {
    const g = createGoal("Test");
    const parent = createTask(g.id, "Global task", 0, "global");
    const sub = createSubtask(parent.id, "Sub task");
    expect(sub.scope).toBe("global");
  });

  it("auto-completes parent when all subtasks done", () => {
    const g = createGoal("Test");
    const parent = createTask(g.id, "Parent");
    const sub1 = createSubtask(parent.id, "Sub 1");
    const sub2 = createSubtask(parent.id, "Sub 2");

    // Complete sub1
    db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(sub1.id);
    // Parent still pending (sub2 not done)
    let p = db.prepare("SELECT * FROM tasks WHERE id = ?").get(parent.id);
    expect(p.status).toBe("pending");

    // Complete sub2 — use the autoCompleteParent logic
    db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(sub2.id);
    // Manually trigger auto-complete check (in real code, updateTaskStatus does this)
    const subs = getSubtasks(parent.id);
    const allDone = subs.every(s => s.status === "done" || s.status === "skipped");
    if (allDone) {
      db.prepare("UPDATE tasks SET status = 'done', result = 'All subtasks completed' WHERE id = ?").run(parent.id);
    }

    p = db.prepare("SELECT * FROM tasks WHERE id = ?").get(parent.id);
    expect(p.status).toBe("done");
  });

  it("top-level getTasksByGoal excludes subtasks", () => {
    const g = createGoal("Test");
    const t1 = createTask(g.id, "Task 1");
    const t2 = createTask(g.id, "Task 2");
    createSubtask(t1.id, "Sub A");
    createSubtask(t1.id, "Sub B");

    const topLevel = db.prepare(
      "SELECT * FROM tasks WHERE goal_id = ? AND parent_task_id IS NULL ORDER BY id"
    ).all(g.id);
    expect(topLevel.length).toBe(2);
    expect(topLevel.map(t => t.title)).toEqual(["Task 1", "Task 2"]);
  });

  it("auto-complete parent cascades to goal completion", () => {
    const g = createGoal("Single task goal");
    const parent = createTask(g.id, "Only task");
    const sub1 = createSubtask(parent.id, "Sub 1");
    const sub2 = createSubtask(parent.id, "Sub 2");

    // Complete all subtasks
    db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(sub1.id);
    db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(sub2.id);

    // Simulate autoCompleteParent
    const subs = getSubtasks(parent.id);
    const allDone = subs.every(s => s.status === "done" || s.status === "skipped");
    if (allDone) {
      db.prepare("UPDATE tasks SET status = 'done', result = 'All subtasks done' WHERE id = ?").run(parent.id);
      // Cascade: check goal
      const stats = getTaskStats(g.id);
      if (stats.pending === 0 && stats.in_progress === 0) {
        db.prepare("UPDATE goals SET status = 'completed', completed_at = datetime('now') WHERE id = ?").run(g.id);
      }
    }

    const goal = db.prepare("SELECT * FROM goals WHERE id = ?").get(g.id);
    expect(goal.status).toBe("completed");
  });

  it("stats count only top-level tasks", () => {
    const g = createGoal("Test");
    const t1 = createTask(g.id, "Task 1");
    createTask(g.id, "Task 2");
    createSubtask(t1.id, "Sub A");
    createSubtask(t1.id, "Sub B");

    const stats = getTaskStats(g.id);
    // Should be 2 (top-level), not 4 (with subtasks)
    expect(stats.total).toBe(2);
  });
});
