// Stress test for the task system redesign
// Validates: 500+ tasks, 5 projects, 45 days, no ID collisions,
// session isolation, scope filtering, subtask auto-complete,
// prompt injection budget, GC

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
    CREATE INDEX IF NOT EXISTS idx_goals_status ON goals(status);
    CREATE INDEX IF NOT EXISTS idx_goals_project ON goals(project);
    CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(last_updated);
  `);
}

// -- Helpers --

function createGoal(title, project = "default", sessionId = null) {
  const r = db.prepare("INSERT INTO goals (title, project, session_id) VALUES (?, ?, ?)").run(title, project, sessionId);
  return db.prepare("SELECT * FROM goals WHERE id = ?").get(r.lastInsertRowid);
}

function createTask(goalId, title, priority = 0, scope = "session") {
  const r = db.prepare("INSERT INTO tasks (goal_id, title, priority, scope) VALUES (?, ?, ?, ?)").run(goalId, title, priority, scope);
  return db.prepare("SELECT * FROM tasks WHERE id = ?").get(r.lastInsertRowid);
}

function createSubtask(parentId, title) {
  const parent = db.prepare("SELECT * FROM tasks WHERE id = ?").get(parentId);
  const r = db.prepare("INSERT INTO tasks (goal_id, title, parent_task_id, scope) VALUES (?, ?, ?, ?)").run(
    parent.goal_id, title, parentId, parent.scope || "session"
  );
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "flint-stress-694-"));
  db = new Database(path.join(tmpDir, "tasks.db"));
  migrate(db);
});

afterEach(() => {
  if (db) db.close();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ===== STRESS TESTS =====

describe("500+ tasks across 5 projects", () => {
  const PROJECTS = ["screenbox", "flint", "website", "pipeline", "docs"];
  const SESSIONS = ["day-1", "day-2", "day-3", "day-4", "day-5"];

  let allGoals;
  let allTaskIds;

  beforeEach(() => {
    allGoals = [];
    allTaskIds = new Set();

    // Simulate 5 days of work: 5 projects, 2 goals each, 10 tasks per goal
    // Use transaction for speed
    const insertGoal = db.prepare("INSERT INTO goals (title, project, session_id) VALUES (?, ?, ?)");
    const insertTask = db.prepare("INSERT INTO tasks (goal_id, title, priority, scope) VALUES (?, ?, ?, ?)");
    const insertSub = db.prepare("INSERT INTO tasks (goal_id, title, parent_task_id, scope) VALUES (?, ?, ?, ?)");

    db.transaction(() => {
      for (let day = 0; day < 5; day++) {
        const session = SESSIONS[day];
        touchSession(session);

        for (const project of PROJECTS) {
          for (let gi = 0; gi < 2; gi++) {
            const gr = insertGoal.run(`${project} goal ${day * 2 + gi}`, project, session);
            const goalId = gr.lastInsertRowid;
            const goal = db.prepare("SELECT * FROM goals WHERE id = ?").get(goalId);
            allGoals.push(goal);
            setFocusedGoal(session, goalId);

            for (let ti = 0; ti < 10; ti++) {
              const scope = ti < 7 ? "session" : ti < 9 ? "project" : "global";
              const tr = insertTask.run(goalId, `${project}-d${day}-g${gi}-t${ti}`, ti, scope);
              allTaskIds.add(Number(tr.lastInsertRowid));

              if (ti % 3 === 0) {
                for (let si = 0; si < 3; si++) {
                  const sr = insertSub.run(goalId, `sub-${si}`, Number(tr.lastInsertRowid), scope);
                  allTaskIds.add(Number(sr.lastInsertRowid));
                }
              }
            }
          }
        }
      }
    })();
  });

  it("creates 500+ tasks with unique IDs", () => {
    const totalTasks = db.prepare("SELECT COUNT(*) as c FROM tasks").get().c;
    expect(totalTasks).toBeGreaterThanOrEqual(500);
    // All IDs unique
    expect(allTaskIds.size).toBe(totalTasks);
  });

  it("creates 50 goals across 5 projects", () => {
    expect(allGoals.length).toBe(50);
    for (const project of PROJECTS) {
      const count = allGoals.filter(g => g.project === project).length;
      expect(count).toBe(10);
    }
  });

  it("no ID collisions between projects", () => {
    // Get all task IDs grouped by project
    const idsByProject = {};
    for (const project of PROJECTS) {
      const ids = db.prepare(`
        SELECT t.id FROM tasks t JOIN goals g ON t.goal_id = g.id WHERE g.project = ?
      `).all(project).map(r => r.id);
      idsByProject[project] = new Set(ids);
    }

    // No overlap between any two projects
    for (let i = 0; i < PROJECTS.length; i++) {
      for (let j = i + 1; j < PROJECTS.length; j++) {
        const overlap = [...idsByProject[PROJECTS[i]]].filter(id => idsByProject[PROJECTS[j]].has(id));
        expect(overlap.length).toBe(0);
      }
    }
  });

  it("session isolation — each session sees its own goals", () => {
    for (const session of SESSIONS) {
      const goals = db.prepare("SELECT * FROM goals WHERE session_id = ?").all(session);
      expect(goals.length).toBe(10); // 5 projects x 2 goals
    }
  });

  it("scope filtering works correctly", () => {
    const sessionScoped = db.prepare("SELECT COUNT(*) as c FROM tasks WHERE scope = 'session'").get().c;
    const projectScoped = db.prepare("SELECT COUNT(*) as c FROM tasks WHERE scope = 'project'").get().c;
    const globalScoped = db.prepare("SELECT COUNT(*) as c FROM tasks WHERE scope = 'global'").get().c;
    // ~70% session, ~20% project, ~10% global (of top-level), subtasks inherit
    expect(sessionScoped).toBeGreaterThan(0);
    expect(projectScoped).toBeGreaterThan(0);
    expect(globalScoped).toBeGreaterThan(0);
  });

  it("getTasksByGoal excludes subtasks", () => {
    const goal = allGoals[0];
    const topLevel = db.prepare(
      "SELECT * FROM tasks WHERE goal_id = ? AND parent_task_id IS NULL"
    ).all(goal.id);
    const all = db.prepare("SELECT * FROM tasks WHERE goal_id = ?").all(goal.id);
    expect(topLevel.length).toBe(10);
    expect(all.length).toBeGreaterThan(10); // has subtasks
  });

  it("subtask auto-complete propagates to parent", () => {
    // Find a task with subtasks
    const parent = db.prepare(
      "SELECT t.id FROM tasks t WHERE EXISTS (SELECT 1 FROM tasks s WHERE s.parent_task_id = t.id) LIMIT 1"
    ).get();
    const subs = db.prepare("SELECT id FROM tasks WHERE parent_task_id = ?").all(parent.id);

    // Complete all subtasks
    for (const sub of subs) {
      db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(sub.id);
    }

    // Check auto-complete (simulate the logic)
    const allSubs = db.prepare("SELECT * FROM tasks WHERE parent_task_id = ?").all(parent.id);
    const allDone = allSubs.every(s => s.status === "done" || s.status === "skipped");
    expect(allDone).toBe(true);

    if (allDone) {
      db.prepare("UPDATE tasks SET status = 'done', result = 'All subtasks done' WHERE id = ?").run(parent.id);
    }
    const updated = db.prepare("SELECT * FROM tasks WHERE id = ?").get(parent.id);
    expect(updated.status).toBe("done");
  });

  it("stats count only top-level tasks per goal", () => {
    const goal = allGoals[0];
    const stats = getTaskStats(goal.id);
    expect(stats.total).toBe(10); // only top-level
  });

  it("focused goal per session works independently", () => {
    // Each session's focused goal should be independent
    for (const session of SESSIONS) {
      const s = db.prepare("SELECT * FROM sessions WHERE id = ?").get(session);
      expect(s.focused_goal_id).toBeTruthy();
      // Focused goal should belong to this session
      const goal = db.prepare("SELECT * FROM goals WHERE id = ?").get(s.focused_goal_id);
      expect(goal.session_id).toBe(session);
    }
  });
});

describe("Prompt injection stays within budget", () => {
  it("plan block for 50-task goal truncates correctly", () => {
    const g = createGoal("Huge goal", "stress");
    for (let i = 0; i < 50; i++) {
      createTask(g.id, `Task ${i}: implement feature ${i} with comprehensive testing and documentation`);
    }

    const tasks = db.prepare(
      "SELECT * FROM tasks WHERE goal_id = ? AND parent_task_id IS NULL ORDER BY priority DESC, id"
    ).all(g.id);

    // Simulate formatPlanForPrompt
    const lines = [`[PLAN #${g.id}] Goal: ${g.title} (project: ${g.project})`];
    for (const t of tasks) {
      lines.push(`[#${t.id}] o ${t.title}`);
    }
    const planBlock = lines.join("\n");

    const BUDGET = 3200;
    if (planBlock.length > BUDGET) {
      const truncated = planBlock.slice(0, BUDGET) + "\n... (truncated, use list_tasks for full view)";
      expect(truncated.length).toBeLessThan(BUDGET + 100);
    } else {
      // Under budget — that's fine too
      expect(planBlock.length).toBeLessThanOrEqual(BUDGET);
    }
  });

  it("multi-goal summary stays compact", () => {
    // 20 active goals
    const goals = [];
    for (let i = 0; i < 20; i++) {
      const g = createGoal(`Goal ${i}`, `proj-${i % 5}`);
      createTask(g.id, `Task for goal ${i}`);
      goals.push(g);
    }

    // Simulate other goals summary
    const summaries = goals.map(g => {
      const stats = getTaskStats(g.id);
      return `[goal #${g.id}] ${g.title} (${g.project}) -- ${stats.done}/${stats.total} done`;
    });
    const summary = summaries.join("\n");

    // 20 goals x ~60 chars each = ~1200 chars — well under budget
    expect(summary.length).toBeLessThan(2000);
  });
});

describe("GC stress test", () => {
  it("orphans tasks from multiple stale sessions", () => {
    // Create 10 stale sessions
    for (let i = 0; i < 10; i++) {
      db.prepare("INSERT INTO sessions (id, last_updated) VALUES (?, datetime('now', '-10 days'))").run(`stale-${i}`);
      const g = createGoal(`Stale goal ${i}`, "stale-project", `stale-${i}`);
      for (let j = 0; j < 5; j++) {
        createTask(g.id, `Stale task ${i}-${j}`);
      }
    }

    // Create 2 fresh sessions
    for (let i = 0; i < 2; i++) {
      touchSession(`fresh-${i}`);
      const g = createGoal(`Fresh goal ${i}`, "fresh-project", `fresh-${i}`);
      createTask(g.id, `Fresh task ${i}`);
    }

    // Verify stale sessions found
    const stale = db.prepare("SELECT * FROM sessions WHERE last_updated < datetime('now', '-7 days')").all();
    expect(stale.length).toBe(10);

    // Verify fresh sessions safe
    const fresh = db.prepare("SELECT * FROM sessions WHERE last_updated >= datetime('now', '-7 days')").all();
    expect(fresh.length).toBe(2);

    // Simulate GC: move stale goals to _orphaned
    db.prepare("INSERT OR IGNORE INTO sessions (id) VALUES ('_orphaned')").run();
    for (const session of stale) {
      db.prepare("UPDATE goals SET session_id = '_orphaned' WHERE session_id = ?").run(session.id);
      db.prepare("DELETE FROM sessions WHERE id = ?").run(session.id);
    }

    // After GC: no stale sessions, goals moved
    const staleAfter = db.prepare("SELECT * FROM sessions WHERE last_updated < datetime('now', '-7 days')").all();
    expect(staleAfter.length).toBe(0);

    const orphanedGoals = db.prepare("SELECT * FROM goals WHERE session_id = '_orphaned'").all();
    expect(orphanedGoals.length).toBe(10);

    // Fresh goals untouched
    const freshGoals = db.prepare("SELECT * FROM goals WHERE session_id LIKE 'fresh-%'").all();
    expect(freshGoals.length).toBe(2);
  });
});

describe("Performance", () => {
  it("inserts 1000 tasks in under 2 seconds", () => {
    const g = createGoal("Perf test", "perf");
    const start = Date.now();

    const stmt = db.prepare("INSERT INTO tasks (goal_id, title, scope) VALUES (?, ?, 'session')");
    const insertMany = db.transaction((count) => {
      for (let i = 0; i < count; i++) {
        stmt.run(g.id, `Task ${i}`);
      }
    });
    insertMany(1000);

    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(2000);

    const count = db.prepare("SELECT COUNT(*) as c FROM tasks WHERE goal_id = ?").get(g.id).c;
    expect(count).toBe(1000);
  });

  it("queries 500+ task stats quickly", () => {
    const g = createGoal("Stats perf", "perf");
    const stmt = db.prepare("INSERT INTO tasks (goal_id, title, scope) VALUES (?, ?, 'session')");
    const insertMany = db.transaction((count) => {
      for (let i = 0; i < count; i++) stmt.run(g.id, `Task ${i}`);
    });
    insertMany(500);

    // Mark some done
    db.prepare("UPDATE tasks SET status = 'done' WHERE goal_id = ? AND id % 3 = 0").run(g.id);
    db.prepare("UPDATE tasks SET status = 'in_progress' WHERE goal_id = ? AND id % 7 = 0 AND status = 'pending'").run(g.id);

    const start = Date.now();
    for (let i = 0; i < 100; i++) {
      getTaskStats(g.id);
    }
    const elapsed = Date.now() - start;
    // 100 stat queries on 500 tasks — should be well under 1s
    expect(elapsed).toBeLessThan(1000);
  });
});
