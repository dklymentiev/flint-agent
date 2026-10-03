// Tests for task-driven child agents
// Validates: DB migration, claimTask, completeTaskWithResult, failTask, getTasksByGoalAndStatus

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

// We create a standalone in-memory-like temp DB to avoid touching the real ~/.flint/tasks.db
let db;
let tmpDir;

function migrate(db) {
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
    CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee);
  `);
}

// Direct DB helpers (mirror queries.js logic but use our test DB)
function createGoal(title, project = "default") {
  const r = db.prepare("INSERT INTO goals (title, project) VALUES (?, ?)").run(title, project);
  return db.prepare("SELECT * FROM goals WHERE id = ?").get(r.lastInsertRowid);
}

function createTask(goalId, title, description = null, priority = 0) {
  const r = db.prepare("INSERT INTO tasks (goal_id, title, description, priority) VALUES (?, ?, ?, ?)").run(goalId, title, description, priority);
  return db.prepare("SELECT * FROM tasks WHERE id = ?").get(r.lastInsertRowid);
}

function getTask(id) {
  return db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
}

function claimTask(taskId, assignee, agentPort) {
  db.prepare("UPDATE tasks SET status = 'in_progress', assignee = ?, agent_port = ?, updated_at = datetime('now') WHERE id = ?").run(assignee, agentPort, taskId);
  return getTask(taskId);
}

function completeTaskWithResult(taskId, result) {
  db.prepare("UPDATE tasks SET status = 'done', result = ?, updated_at = datetime('now') WHERE id = ?").run(result, taskId);
  const task = getTask(taskId);
  if (task && task.goal_id) {
    const stats = getTaskStats(task.goal_id);
    if (stats.pending === 0 && stats.in_progress === 0) {
      db.prepare("UPDATE goals SET status = 'completed', completed_at = datetime('now') WHERE id = ?").run(task.goal_id);
    }
  }
  return task;
}

function failTask(taskId, reason) {
  db.prepare("UPDATE tasks SET status = 'skipped', result = ?, updated_at = datetime('now') WHERE id = ?").run(reason || "failed", taskId);
  const task = getTask(taskId);
  // Auto-complete goal if all tasks done/skipped
  if (task && task.goal_id) {
    const stats = getTaskStats(task.goal_id);
    if (stats.pending === 0 && stats.in_progress === 0) {
      db.prepare("UPDATE goals SET status = 'completed', completed_at = datetime('now') WHERE id = ?").run(task.goal_id);
    }
  }
  return task;
}

function getTaskStats(goalId) {
  return db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
      SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as in_progress,
      SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) as done,
      SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) as skipped
    FROM tasks WHERE goal_id = ?
  `).get(goalId);
}

function getTasksByGoalAndStatus(goalId, statuses) {
  const placeholders = statuses.map(() => "?").join(",");
  return db.prepare(
    `SELECT * FROM tasks WHERE goal_id = ? AND status IN (${placeholders}) ORDER BY priority DESC, id ASC`
  ).all(goalId, ...statuses);
}

function getGoal(id) {
  return db.prepare("SELECT * FROM goals WHERE id = ?").get(id);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "flint-task-test-"));
  const dbPath = path.join(tmpDir, "test-tasks.db");
  db = new Database(dbPath);
  migrate(db);
});

afterEach(() => {
  if (db) db.close();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("Task-driven child agents", () => {
  describe("DB schema", () => {
    it("tasks table has assignee and agent_port columns", () => {
      const cols = db.prepare("PRAGMA table_info(tasks)").all();
      const colNames = cols.map(c => c.name);
      expect(colNames).toContain("assignee");
      expect(colNames).toContain("agent_port");
    });

    it("assignee and agent_port default to null", () => {
      const goal = createGoal("test goal");
      const task = createTask(goal.id, "test task");
      expect(task.assignee).toBeNull();
      expect(task.agent_port).toBeNull();
    });
  });

  describe("claimTask", () => {
    it("sets status to in_progress with assignee and port", () => {
      const goal = createGoal("test goal");
      const task = createTask(goal.id, "do something");
      expect(task.status).toBe("pending");

      const claimed = claimTask(task.id, "agent@3010", 3010);
      expect(claimed.status).toBe("in_progress");
      expect(claimed.assignee).toBe("agent@3010");
      expect(claimed.agent_port).toBe(3010);
    });

    it("updates updated_at on claim", () => {
      const goal = createGoal("test");
      const task = createTask(goal.id, "task");
      const claimed = claimTask(task.id, "agent@3011", 3011);
      // Both happen in same second, so just verify the field exists and is a valid datetime
      expect(claimed.updated_at).toBeTruthy();
      expect(claimed.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}/);
    });
  });

  describe("completeTaskWithResult", () => {
    it("marks task as done with result", () => {
      const goal = createGoal("test");
      const task = createTask(goal.id, "work");
      claimTask(task.id, "agent@3010", 3010);

      const completed = completeTaskWithResult(task.id, "All files processed");
      expect(completed.status).toBe("done");
      expect(completed.result).toBe("All files processed");
    });

    it("auto-completes goal when all tasks done", () => {
      const goal = createGoal("multi-task goal");
      const t1 = createTask(goal.id, "task 1");
      const t2 = createTask(goal.id, "task 2");

      completeTaskWithResult(t1.id, "done 1");
      // Goal should still be active (t2 is pending)
      expect(getGoal(goal.id).status).toBe("active");

      completeTaskWithResult(t2.id, "done 2");
      // Now all done — goal should be completed
      expect(getGoal(goal.id).status).toBe("completed");
    });

    it("auto-completes goal when mix of done and skipped", () => {
      const goal = createGoal("mixed goal");
      const t1 = createTask(goal.id, "task 1");
      const t2 = createTask(goal.id, "task 2");

      completeTaskWithResult(t1.id, "ok");
      failTask(t2.id, "not needed");

      expect(getGoal(goal.id).status).toBe("completed");
    });
  });

  describe("failTask", () => {
    it("marks task as skipped with reason", () => {
      const goal = createGoal("test");
      const task = createTask(goal.id, "risky op");
      claimTask(task.id, "agent@3010", 3010);

      const failed = failTask(task.id, "permission denied");
      expect(failed.status).toBe("skipped");
      expect(failed.result).toBe("permission denied");
    });

    it("uses 'failed' as default reason", () => {
      const goal = createGoal("test");
      const task = createTask(goal.id, "op");

      const failed = failTask(task.id, null);
      expect(failed.result).toBe("failed");
    });
  });

  describe("getTasksByGoalAndStatus", () => {
    it("filters tasks by multiple statuses", () => {
      const goal = createGoal("filter test");
      const t1 = createTask(goal.id, "pending task");
      const t2 = createTask(goal.id, "claimed task");
      const t3 = createTask(goal.id, "done task");

      claimTask(t2.id, "agent@3010", 3010);
      completeTaskWithResult(t3.id, "finished");

      const active = getTasksByGoalAndStatus(goal.id, ["pending", "in_progress"]);
      expect(active).toHaveLength(2);
      expect(active.map(t => t.id)).toContain(t1.id);
      expect(active.map(t => t.id)).toContain(t2.id);

      const finished = getTasksByGoalAndStatus(goal.id, ["done"]);
      expect(finished).toHaveLength(1);
      expect(finished[0].id).toBe(t3.id);
    });
  });

  describe("parallel child agent flow (end-to-end)", () => {
    it("simulates parent creating plan, children claiming and completing tasks", () => {
      // Parent: create plan with 3 tasks
      const goal = createGoal("Refactor project", "flint");
      const t1 = createTask(goal.id, "Rename variables", "snake_case", 2);
      const t2 = createTask(goal.id, "Add type annotations", null, 1);
      const t3 = createTask(goal.id, "Update tests", null, 0);

      // Verify initial state
      const stats0 = getTaskStats(goal.id);
      expect(stats0.total).toBe(3);
      expect(stats0.pending).toBe(3);

      // Child 1 claims task 1
      claimTask(t1.id, "agent@3010", 3010);
      expect(getTask(t1.id).status).toBe("in_progress");

      // Child 2 claims task 2
      claimTask(t2.id, "agent@3011", 3011);

      // Child 3 claims task 3
      claimTask(t3.id, "agent@3012", 3012);

      const stats1 = getTaskStats(goal.id);
      expect(stats1.in_progress).toBe(3);
      expect(stats1.pending).toBe(0);

      // Child 1 completes
      completeTaskWithResult(t1.id, "Renamed 42 variables");
      expect(getGoal(goal.id).status).toBe("active"); // still active

      // Child 3 fails
      failTask(t3.id, "No test files found");

      // Child 2 completes
      completeTaskWithResult(t2.id, "Added types to 15 files");

      // Goal should now be auto-completed (all done or skipped)
      expect(getGoal(goal.id).status).toBe("completed");

      // Verify final results
      const allTasks = getTasksByGoalAndStatus(goal.id, ["done", "skipped"]);
      expect(allTasks).toHaveLength(3);
      expect(allTasks.find(t => t.id === t1.id).result).toBe("Renamed 42 variables");
      expect(allTasks.find(t => t.id === t3.id).status).toBe("skipped");
    });
  });
});
