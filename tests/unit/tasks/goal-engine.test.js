// Tests for goal engine: goal lifecycle, task lifecycle, subtasks, auto-complete,
// multi-goal, sessions, daily focus, metadata, reminders
// Phase R3 of the foundation roadmap

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";

// --- Mock getDb() to return an in-memory SQLite database per test ---
let testDb;

function createTestDb() {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

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
    CREATE TABLE IF NOT EXISTS message_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel TEXT NOT NULL,
      content TEXT NOT NULL,
      priority INTEGER DEFAULT 5,
      source TEXT,
      metadata TEXT,
      status TEXT DEFAULT 'pending',
      session_id TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      processed_at TEXT,
      result TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_goal ON tasks(goal_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_goals_status ON goals(status);
    CREATE INDEX IF NOT EXISTS idx_goals_project ON goals(project);
    CREATE INDEX IF NOT EXISTS idx_tasks_next_run ON tasks(next_run);
    CREATE INDEX IF NOT EXISTS idx_tasks_scope ON tasks(scope);
    CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_task_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(last_updated);
  `);
  return db;
}

vi.mock("../../../src/tasks/db.js", () => ({
  getDb: () => testDb,
  closeDb: () => {},
}));

// Import query functions AFTER the mock is set up
const Q = await import("../../../src/tasks/queries.js");

beforeEach(() => {
  testDb = createTestDb();
});

afterEach(() => {
  if (testDb) {
    testDb.close();
    testDb = null;
  }
});

// ============================================================
// Goal Lifecycle
// ============================================================

describe("Goal lifecycle", () => {
  it("createGoal returns goal with id, title, status=active", () => {
    const g = Q.createGoal("Build the widget");
    expect(g).toBeDefined();
    expect(g.id).toBeGreaterThan(0);
    expect(g.title).toBe("Build the widget");
    expect(g.status).toBe("active");
    expect(g.created_at).toBeDefined();
  });

  it("createGoal links to session via session_id", () => {
    const g = Q.createGoal("Deploy app", "default", "sess-123");
    expect(g.session_id).toBe("sess-123");
  });

  it("createGoal uses project parameter", () => {
    const g = Q.createGoal("Fix bug", "my-project");
    expect(g.project).toBe("my-project");
  });

  it("getGoal retrieves by id", () => {
    const g = Q.createGoal("Test goal");
    const fetched = Q.getGoal(g.id);
    expect(fetched).toBeDefined();
    expect(fetched.id).toBe(g.id);
    expect(fetched.title).toBe("Test goal");
  });

  it("getGoal returns undefined for non-existent id", () => {
    const result = Q.getGoal(99999);
    expect(result).toBeUndefined();
  });

  it("getActiveGoal returns active goal for session", () => {
    Q.touchSession("s1");
    const g = Q.createGoal("Active goal", "default", "s1");
    Q.setFocusedGoal("s1", g.id);
    const active = Q.getActiveGoal(null, "s1");
    expect(active).toBeDefined();
    expect(active.id).toBe(g.id);
  });

  it("getActiveGoal returns an active goal when no session", () => {
    Q.createGoal("Goal A");
    Q.createGoal("Goal B");
    const active = Q.getActiveGoal();
    expect(active).toBeDefined();
    expect(active.status).toBe("active");
  });

  it("listGoals returns all goals", () => {
    Q.createGoal("Goal A");
    Q.createGoal("Goal B");
    Q.createGoal("Goal C");
    const all = Q.listGoals();
    expect(all).toHaveLength(3);
  });

  it("listGoals filterable by status", () => {
    const g1 = Q.createGoal("Goal 1");
    Q.createGoal("Goal 2");
    Q.completeGoal(g1.id);
    const active = Q.listGoals("active");
    const completed = Q.listGoals("completed");
    expect(active).toHaveLength(1);
    expect(completed).toHaveLength(1);
    expect(completed[0].title).toBe("Goal 1");
  });

  it("completeGoal sets status=completed, completed_at filled", () => {
    const g = Q.createGoal("To complete");
    Q.completeGoal(g.id);
    const updated = Q.getGoal(g.id);
    expect(updated.status).toBe("completed");
    expect(updated.completed_at).toBeDefined();
    expect(updated.completed_at).not.toBeNull();
  });

  it("abandonGoal sets status=abandoned", () => {
    const g = Q.createGoal("To abandon");
    Q.abandonGoal(g.id);
    const updated = Q.getGoal(g.id);
    expect(updated.status).toBe("abandoned");
    expect(updated.completed_at).toBeDefined();
  });

  it("abandonAllActiveGoals abandons all active goals", () => {
    Q.createGoal("Goal A");
    Q.createGoal("Goal B");
    Q.createGoal("Goal C");
    Q.abandonAllActiveGoals();
    const active = Q.listGoals("active");
    const abandoned = Q.listGoals("abandoned");
    expect(active).toHaveLength(0);
    expect(abandoned).toHaveLength(3);
  });
});

// ============================================================
// Task Lifecycle
// ============================================================

describe("Task lifecycle", () => {
  let goal;

  beforeEach(() => {
    goal = Q.createGoal("Test goal");
  });

  it("createTask under a goal, status=pending by default", () => {
    const t = Q.createTask(goal.id, "Write tests");
    expect(t).toBeDefined();
    expect(t.id).toBeGreaterThan(0);
    expect(t.goal_id).toBe(goal.id);
    expect(t.title).toBe("Write tests");
    expect(t.status).toBe("pending");
  });

  it("createTask with description and priority", () => {
    const t = Q.createTask(goal.id, "Important task", "A description", 10);
    expect(t.description).toBe("A description");
    expect(t.priority).toBe(10);
  });

  it("updateTaskStatus: pending -> in_progress -> done", () => {
    const t = Q.createTask(goal.id, "Step 1");
    Q.updateTaskStatus(t.id, "in_progress");
    let updated = Q.getTask(t.id);
    expect(updated.status).toBe("in_progress");

    Q.updateTaskStatus(t.id, "done", "Completed successfully");
    updated = Q.getTask(t.id);
    expect(updated.status).toBe("done");
    expect(updated.result).toBe("Completed successfully");
  });

  it("updateTaskStatus: pending -> skipped", () => {
    const t = Q.createTask(goal.id, "Skip me");
    Q.updateTaskStatus(t.id, "skipped", "Not needed");
    const updated = Q.getTask(t.id);
    expect(updated.status).toBe("skipped");
    expect(updated.result).toBe("Not needed");
  });

  it("getNextPendingTask returns first pending task for a goal", () => {
    Q.createTask(goal.id, "Task 1");
    Q.createTask(goal.id, "Task 2");
    const next = Q.getNextPendingTask(goal.id);
    expect(next).toBeDefined();
    expect(next.title).toBe("Task 1");
  });

  it("getNextPendingTask returns in_progress task too", () => {
    const t1 = Q.createTask(goal.id, "Task 1");
    Q.createTask(goal.id, "Task 2");
    Q.updateTaskStatus(t1.id, "in_progress");
    const next = Q.getNextPendingTask(goal.id);
    expect(next.title).toBe("Task 1");
  });

  it("getNextPendingTask respects priority ordering", () => {
    Q.createTask(goal.id, "Low priority", null, 0);
    Q.createTask(goal.id, "High priority", null, 10);
    const next = Q.getNextPendingTask(goal.id);
    expect(next.title).toBe("High priority");
  });

  it("getTasksByGoal returns all top-level tasks", () => {
    Q.createTask(goal.id, "Task A");
    Q.createTask(goal.id, "Task B");
    Q.createTask(goal.id, "Task C");
    const tasks = Q.getTasksByGoal(goal.id);
    expect(tasks).toHaveLength(3);
  });

  it("getTaskStats returns correct counts", () => {
    const t1 = Q.createTask(goal.id, "Pending 1");
    const t2 = Q.createTask(goal.id, "Pending 2");
    const t3 = Q.createTask(goal.id, "Pending 3");
    const t4 = Q.createTask(goal.id, "Pending 4");

    Q.updateTaskStatus(t1.id, "done");
    Q.updateTaskStatus(t2.id, "in_progress");
    Q.updateTaskStatus(t3.id, "skipped");

    const stats = Q.getTaskStats(goal.id);
    expect(stats.done).toBe(1);
    expect(stats.in_progress).toBe(1);
    expect(stats.skipped).toBe(1);
    expect(stats.pending).toBe(1);
    expect(stats.total).toBe(4);
  });
});

// ============================================================
// Subtask Hierarchy
// ============================================================

describe("Subtask hierarchy", () => {
  let goal;

  beforeEach(() => {
    goal = Q.createGoal("Subtask goal");
  });

  it("createSubtask links to parent task", () => {
    const parent = Q.createTask(goal.id, "Parent task");
    const sub = Q.createSubtask(parent.id, "Child task");
    expect(sub).toBeDefined();
    expect(sub.parent_task_id).toBe(parent.id);
    expect(sub.goal_id).toBe(goal.id);
  });

  it("getSubtasks returns children", () => {
    const parent = Q.createTask(goal.id, "Parent");
    Q.createSubtask(parent.id, "Sub 1");
    Q.createSubtask(parent.id, "Sub 2");
    const subs = Q.getSubtasks(parent.id);
    expect(subs).toHaveLength(2);
    expect(subs[0].title).toBe("Sub 1");
    expect(subs[1].title).toBe("Sub 2");
  });

  it("createSubtask returns null for non-existent parent", () => {
    const result = Q.createSubtask(99999, "Orphan");
    expect(result).toBeNull();
  });

  it("subtask inherits scope from parent", () => {
    const parent = Q.createTask(goal.id, "Parent", null, 0, "project");
    const sub = Q.createSubtask(parent.id, "Sub");
    expect(sub.scope).toBe("project");
  });

  it("2-level nesting works: subtask of subtask", () => {
    const parent = Q.createTask(goal.id, "Level 0");
    const sub1 = Q.createSubtask(parent.id, "Level 1");
    const sub2 = Q.createSubtask(sub1.id, "Level 2");
    expect(sub2).toBeDefined();
    expect(sub2.parent_task_id).toBe(sub1.id);
  });

  it("auto-complete: all subtasks done/skipped -> parent auto-completes", () => {
    const parent = Q.createTask(goal.id, "Parent");
    const s1 = Q.createSubtask(parent.id, "Sub 1");
    const s2 = Q.createSubtask(parent.id, "Sub 2");

    Q.updateTaskStatus(s1.id, "done");
    Q.updateTaskStatus(s2.id, "skipped");

    const updated = Q.getTask(parent.id);
    expect(updated.status).toBe("done");
    expect(updated.result).toContain("subtasks completed");
  });

  it("auto-complete does not trigger if some subtasks still pending", () => {
    const parent = Q.createTask(goal.id, "Parent");
    const s1 = Q.createSubtask(parent.id, "Sub 1");
    Q.createSubtask(parent.id, "Sub 2");

    Q.updateTaskStatus(s1.id, "done");

    const updated = Q.getTask(parent.id);
    expect(updated.status).toBe("pending");
  });

  it("auto-complete cascade: all top-level tasks done -> goal auto-completes", () => {
    const t1 = Q.createTask(goal.id, "Task 1");
    const t2 = Q.createTask(goal.id, "Task 2");

    // Task 1: has subtasks, complete them to auto-complete parent
    const s1 = Q.createSubtask(t1.id, "Sub 1");
    Q.updateTaskStatus(s1.id, "done");
    // After s1 done, t1 should auto-complete (only subtask)
    expect(Q.getTask(t1.id).status).toBe("done");

    // Now complete t2 via completeTaskWithResult (this triggers goal auto-complete)
    Q.completeTaskWithResult(t2.id, "Finished");

    const goalState = Q.getGoal(goal.id);
    expect(goalState.status).toBe("completed");
  });

  it("getTasksByGoal excludes subtasks (only top-level)", () => {
    const t1 = Q.createTask(goal.id, "Top 1");
    Q.createSubtask(t1.id, "Sub 1");
    Q.createSubtask(t1.id, "Sub 2");
    const tasks = Q.getTasksByGoal(goal.id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe("Top 1");
  });
});

// ============================================================
// Multi-goal
// ============================================================

describe("Multi-goal", () => {
  it("setFocusedGoal / getFocusedGoal", () => {
    Q.touchSession("sess-1");
    const g1 = Q.createGoal("Goal 1", "default", "sess-1");
    Q.setFocusedGoal("sess-1", g1.id);
    const focused = Q.getFocusedGoal("sess-1");
    expect(focused).toBeDefined();
    expect(focused.id).toBe(g1.id);
  });

  it("create 2 goals, switch focus, verify", () => {
    Q.touchSession("sess-2");
    const g1 = Q.createGoal("Goal A", "default", "sess-2");
    const g2 = Q.createGoal("Goal B", "default", "sess-2");

    Q.setFocusedGoal("sess-2", g1.id);
    expect(Q.getFocusedGoal("sess-2").id).toBe(g1.id);

    Q.setFocusedGoal("sess-2", g2.id);
    expect(Q.getFocusedGoal("sess-2").id).toBe(g2.id);
  });

  it("getFocusedGoal returns null for completed goal", () => {
    Q.touchSession("sess-3");
    const g = Q.createGoal("Will complete", "default", "sess-3");
    Q.setFocusedGoal("sess-3", g.id);
    Q.completeGoal(g.id);
    const focused = Q.getFocusedGoal("sess-3");
    expect(focused).toBeNull();
  });

  it("getFocusedGoal returns null for no session", () => {
    const focused = Q.getFocusedGoal(null);
    expect(focused).toBeNull();
  });

  it("getActiveGoals returns all active goals", () => {
    Q.createGoal("A");
    Q.createGoal("B");
    const g3 = Q.createGoal("C");
    Q.completeGoal(g3.id);
    const active = Q.getActiveGoals();
    expect(active).toHaveLength(2);
  });
});

// ============================================================
// Session
// ============================================================

describe("Session", () => {
  it("touchSession creates session record", () => {
    Q.touchSession("new-sess");
    const s = Q.getSession("new-sess");
    expect(s).toBeDefined();
    expect(s.id).toBe("new-sess");
    expect(s.created_at).toBeDefined();
  });

  it("touchSession updates last_updated on second call", () => {
    Q.touchSession("upd-sess");
    const s1 = Q.getSession("upd-sess");
    // Call again (upsert)
    Q.touchSession("upd-sess");
    const s2 = Q.getSession("upd-sess");
    expect(s2).toBeDefined();
    // Both calls should succeed without error
    expect(s2.id).toBe("upd-sess");
  });

  it("getSession returns session data", () => {
    Q.touchSession("data-sess");
    const s = Q.getSession("data-sess");
    expect(s.id).toBe("data-sess");
    expect(s.last_updated).toBeDefined();
    expect(s.focused_goal_id).toBeNull();
  });

  it("getSession returns undefined for non-existent session", () => {
    const s = Q.getSession("no-such");
    expect(s).toBeUndefined();
  });

  it("touchSession with null does nothing", () => {
    Q.touchSession(null);
    // Should not throw
  });
});

// ============================================================
// Daily Focus
// ============================================================

describe("Daily focus", () => {
  let goal;

  beforeEach(() => {
    goal = Q.createGoal("Focus goal");
  });

  it("setDailyFocus marks tasks", () => {
    const t = Q.createTask(goal.id, "Focus task");
    Q.setDailyFocus(t.id, "2026-04-08");
    const updated = Q.getTask(t.id);
    expect(updated.daily_focus).toBe("2026-04-08");
  });

  it("getTodayTasks returns focused tasks", () => {
    const t1 = Q.createTask(goal.id, "Focused");
    const t2 = Q.createTask(goal.id, "Not focused");
    Q.setDailyFocus(t1.id, "2026-04-08");

    const today = Q.getTodayTasks("2026-04-08");
    expect(today).toHaveLength(1);
    expect(today[0].title).toBe("Focused");
  });

  it("getTodayTasks excludes done tasks", () => {
    const t = Q.createTask(goal.id, "Done task");
    Q.setDailyFocus(t.id, "2026-04-08");
    Q.updateTaskStatus(t.id, "done");

    const today = Q.getTodayTasks("2026-04-08");
    expect(today).toHaveLength(0);
  });

  it("clearDailyFocus removes focus", () => {
    const t = Q.createTask(goal.id, "Clear me");
    Q.setDailyFocus(t.id, "2026-04-08");
    Q.clearDailyFocus(t.id);
    const updated = Q.getTask(t.id);
    expect(updated.daily_focus).toBeNull();
  });

  it("getTodayTasks includes goal metadata", () => {
    const t = Q.createTask(goal.id, "With goal info");
    Q.setDailyFocus(t.id, "2026-04-08");
    const today = Q.getTodayTasks("2026-04-08");
    expect(today[0].goal_title).toBe("Focus goal");
    expect(today[0].project).toBe("default");
  });
});

// ============================================================
// Task Metadata
// ============================================================

describe("Task metadata", () => {
  let goal;
  let task;

  beforeEach(() => {
    goal = Q.createGoal("Metadata goal");
    task = Q.createTask(goal.id, "Metadata task");
  });

  it("addNote / getTaskNotes", () => {
    const r = Q.addNote(task.id, "Important observation");
    expect(r.id).toBeGreaterThan(0);

    Q.addNote(task.id, "Second note");
    const notes = Q.getTaskNotes(task.id);
    expect(notes).toHaveLength(2);
    expect(notes[0].note).toBe("Important observation");
    expect(notes[1].note).toBe("Second note");
  });

  it("linkFile / getTaskFiles", () => {
    const r = Q.linkFile(task.id, "/path/to/file.js", "created");
    expect(r.id).toBeGreaterThan(0);

    Q.linkFile(task.id, "/path/to/other.js", "modified");
    const files = Q.getTaskFiles(task.id);
    expect(files).toHaveLength(2);
    expect(files[0].path).toBe("/path/to/file.js");
    expect(files[0].role).toBe("created");
  });

  it("linkFile deduplicates same path", () => {
    Q.linkFile(task.id, "/same/path.js", "created");
    Q.linkFile(task.id, "/same/path.js", "modified");
    const files = Q.getTaskFiles(task.id);
    expect(files).toHaveLength(1);
  });

  it("getTaskNotes returns empty array for no notes", () => {
    const notes = Q.getTaskNotes(task.id);
    expect(notes).toEqual([]);
  });

  it("getTaskFiles returns empty array for no files", () => {
    const files = Q.getTaskFiles(task.id);
    expect(files).toEqual([]);
  });
});

// ============================================================
// Scheduling / Reminders
// ============================================================

describe("Scheduling / Reminders", () => {
  it("createReminder with next_run", () => {
    const r = Q.createReminder("Check deploy", "2026-04-08T12:00:00.000Z");
    expect(r).toBeDefined();
    expect(r.title).toBe("Check deploy");
    expect(r.next_run).toBe("2026-04-08T12:00:00.000Z");
    expect(r.status).toBe("pending");
  });

  it("createReminder with repeat interval", () => {
    const r = Q.createReminder("Hourly check", "2026-04-08T12:00:00.000Z", "1h");
    expect(r.repeat).toBe("1h");
  });

  it("getDueReminders finds reminders past due", () => {
    // Use SQLite-compatible datetime format (no T, no Z) so text comparison
    // with datetime('now') works correctly
    const past = new Date(Date.now() - 3600000).toISOString()
      .replace("T", " ").replace("Z", "").replace(/\.\d+$/, "");
    Q.createReminder("Past reminder", past);

    // Create a reminder far in the future
    Q.createReminder("Future reminder", "2099-01-01 00:00:00");

    const due = Q.getDueReminders();
    expect(due).toHaveLength(1);
    expect(due[0].title).toBe("Past reminder");
  });

  it("fireReminder for one-time: marks done, clears next_run", () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const r = Q.createReminder("One-time", past);
    const fired = Q.fireReminder(r.id, null);
    expect(fired.status).toBe("done");
    expect(fired.next_run).toBeNull();
  });

  it("fireReminder for recurring: advances next_run", () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const r = Q.createReminder("Recurring", past, "1h");
    const fired = Q.fireReminder(r.id, "1h");
    expect(fired.status).toBe("pending");
    expect(fired.next_run).toBeDefined();
    // next_run should be roughly 1 hour from now
    const nextTime = new Date(fired.next_run).getTime();
    const expected = Date.now() + 3600000;
    expect(Math.abs(nextTime - expected)).toBeLessThan(5000);
  });

  it("cancelReminder marks as skipped", () => {
    const r = Q.createReminder("Cancel me", "2026-04-08T12:00:00.000Z");
    const cancelled = Q.cancelReminder(r.id);
    expect(cancelled.status).toBe("skipped");
    expect(cancelled.next_run).toBeNull();
  });
});

// ============================================================
// Dashboard & Plan conversion
// ============================================================

describe("Dashboard & Plan conversion", () => {
  it("getDashboard returns active goals with tasks and stats", () => {
    const g = Q.createGoal("Dashboard goal");
    const t1 = Q.createTask(g.id, "T1");
    Q.createTask(g.id, "T2");
    Q.updateTaskStatus(t1.id, "done");

    const dashboard = Q.getDashboard();
    expect(dashboard).toHaveLength(1);
    expect(dashboard[0].title).toBe("Dashboard goal");
    expect(dashboard[0].tasks).toHaveLength(2);
    expect(dashboard[0].stats.done).toBe(1);
    expect(dashboard[0].stats.pending).toBe(1);
  });

  it("getDashboard returns empty for no active goals", () => {
    const g = Q.createGoal("Will complete");
    Q.completeGoal(g.id);
    const dashboard = Q.getDashboard();
    expect(dashboard).toEqual([]);
  });

  it("goalToPlan converts goal and tasks to plan format", () => {
    const g = Q.createGoal("Plan goal", "my-proj");
    const t1 = Q.createTask(g.id, "Step 1");
    const t2 = Q.createTask(g.id, "Step 2");
    Q.createSubtask(t1.id, "Sub A");

    const tasks = Q.getTasksByGoal(g.id);
    const plan = Q.goalToPlan(g, tasks);

    expect(plan.goal).toBe("Plan goal");
    expect(plan.goalId).toBe(g.id);
    expect(plan.project).toBe("my-proj");
    expect(plan.tasks).toHaveLength(2);
    expect(plan.tasks[0].subtasks).toHaveLength(1);
    expect(plan.tasks[0].subtasks[0].title).toBe("Sub A");
  });

  it("goalToPlan returns null for null goal", () => {
    expect(Q.goalToPlan(null, [])).toBeNull();
  });
});
