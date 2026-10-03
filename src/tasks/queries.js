// CRUD operations for persistent tasks
import { getDb } from "./db.js";

// -- Sessions --

export function touchSession(sessionId) {
  if (!sessionId) return;
  // Single upsert instead of SELECT+UPDATE — hot path fix
  getDb().prepare(
    "INSERT INTO sessions (id) VALUES (?) ON CONFLICT(id) DO UPDATE SET last_updated = datetime('now')"
  ).run(sessionId);
}

export function getSession(sessionId) {
  return getDb().prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId);
}

export function setFocusedGoal(sessionId, goalId) {
  if (!sessionId) return;
  touchSession(sessionId);
  getDb().prepare("UPDATE sessions SET focused_goal_id = ? WHERE id = ?").run(goalId, sessionId);
}

export function getFocusedGoal(sessionId) {
  if (!sessionId) return null;
  const session = getSession(sessionId);
  if (!session || !session.focused_goal_id) return null;
  const goal = getGoal(session.focused_goal_id);
  // Only return if still active
  return goal && goal.status === "active" ? goal : null;
}

export function getStaleSessions(days = 7) {
  return getDb().prepare(
    "SELECT * FROM sessions WHERE last_updated < datetime('now', ? || ' days')"
  ).all(-days);
}

// -- Goals --

export function createGoal(title, project = "default", sessionId = null) {
  const db = getDb();
  const r = db.prepare(
    "INSERT INTO goals (title, project, session_id) VALUES (?, ?, ?)"
  ).run(title, project, sessionId);
  return getGoal(r.lastInsertRowid);
}

export function getGoal(id) {
  return getDb().prepare("SELECT * FROM goals WHERE id = ?").get(id);
}

/** Get the focused goal for a session, or most recent active goal */
export function getActiveGoal(project = null, sessionId = null) {
  const db = getDb();
  // If session has a focused goal, prefer it
  if (sessionId) {
    const focused = getFocusedGoal(sessionId);
    if (focused) {
      if (!project || focused.project === project) return focused;
    }
  }
  if (project) {
    return db.prepare(
      "SELECT * FROM goals WHERE status = 'active' AND project = ? ORDER BY created_at DESC LIMIT 1"
    ).get(project);
  }
  return db.prepare(
    "SELECT * FROM goals WHERE status = 'active' ORDER BY created_at DESC LIMIT 1"
  ).get();
}

/** Get ALL active goals (for multi-goal support) */
export function getActiveGoals() {
  return getDb().prepare(
    "SELECT * FROM goals WHERE status = 'active' ORDER BY created_at DESC"
  ).all();
}

export function listGoals(status = null) {
  const db = getDb();
  if (status) {
    return db.prepare("SELECT * FROM goals WHERE status = ? ORDER BY created_at DESC").all(status);
  }
  return db.prepare("SELECT * FROM goals ORDER BY created_at DESC").all();
}

export function completeGoal(id) {
  getDb().prepare(
    "UPDATE goals SET status = 'completed', completed_at = datetime('now') WHERE id = ?"
  ).run(id);
}

export function abandonGoal(id) {
  getDb().prepare(
    "UPDATE goals SET status = 'abandoned', completed_at = datetime('now') WHERE id = ?"
  ).run(id);
}

/** Abandon all active goals (used on /new to prevent plan leakage between sessions) */
export function abandonAllActiveGoals() {
  getDb().prepare(
    "UPDATE goals SET status = 'abandoned', completed_at = datetime('now') WHERE status = 'active'"
  ).run();
}

// -- Tasks --

export function createTask(goalId, title, description = null, priority = 0, scope = "session") {
  const db = getDb();
  const r = db.prepare(
    "INSERT INTO tasks (goal_id, title, description, priority, scope) VALUES (?, ?, ?, ?, ?)"
  ).run(goalId, title, description, priority, scope);
  return getTask(r.lastInsertRowid);
}

export function createSubtask(parentTaskId, title, description = null) {
  const db = getDb();
  const parent = getTask(parentTaskId);
  if (!parent) return null;
  const r = db.prepare(
    "INSERT INTO tasks (goal_id, title, description, parent_task_id, scope) VALUES (?, ?, ?, ?, ?)"
  ).run(parent.goal_id, title, description, parentTaskId, parent.scope || "session");
  return getTask(r.lastInsertRowid);
}

export function getSubtasks(parentTaskId) {
  return getDb().prepare(
    "SELECT * FROM tasks WHERE parent_task_id = ? ORDER BY id ASC"
  ).all(parentTaskId);
}

export function getTask(id) {
  return getDb().prepare("SELECT * FROM tasks WHERE id = ?").get(id);
}

export function getTasksByGoal(goalId) {
  return getDb().prepare(
    "SELECT * FROM tasks WHERE goal_id = ? AND parent_task_id IS NULL ORDER BY priority DESC, id ASC"
  ).all(goalId);
}


export function updateTaskStatus(id, status, result = null) {
  const db = getDb();
  if (result != null) {
    db.prepare(
      "UPDATE tasks SET status = ?, result = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(status, result, id);
  } else {
    db.prepare(
      "UPDATE tasks SET status = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(status, id);
  }
  const task = getTask(id);
  // Auto-complete parent if all subtasks done/skipped
  if (task && task.parent_task_id && (status === "done" || status === "skipped")) {
    autoCompleteParent(task.parent_task_id);
  }
  return task;
}

export function getNextPendingTask(goalId) {
  return getDb().prepare(
    "SELECT * FROM tasks WHERE goal_id = ? AND status IN ('pending', 'in_progress') ORDER BY priority DESC, id ASC LIMIT 1"
  ).get(goalId);
}

export function getTaskStats(goalId) {
  const row = getDb().prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
      SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as in_progress,
      SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) as done,
      SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) as skipped
    FROM tasks WHERE goal_id = ? AND parent_task_id IS NULL
  `).get(goalId);
  return row;
}

// -- Task Files --

export function linkFile(taskId, filePath, role = "related") {
  const db = getDb();
  // Avoid duplicates
  const existing = db.prepare(
    "SELECT id FROM task_files WHERE task_id = ? AND path = ?"
  ).get(taskId, filePath);
  if (existing) return existing;
  const r = db.prepare(
    "INSERT INTO task_files (task_id, path, role) VALUES (?, ?, ?)"
  ).run(taskId, filePath, role);
  return { id: r.lastInsertRowid };
}

export function getTaskFiles(taskId) {
  return getDb().prepare(
    "SELECT * FROM task_files WHERE task_id = ? ORDER BY added_at"
  ).all(taskId);
}

// -- Task Notes --

export function addNote(taskId, note) {
  const db = getDb();
  const r = db.prepare(
    "INSERT INTO task_notes (task_id, note) VALUES (?, ?)"
  ).run(taskId, note);
  return { id: r.lastInsertRowid };
}

export function getTaskNotes(taskId) {
  return getDb().prepare(
    "SELECT * FROM task_notes WHERE task_id = ? ORDER BY created_at"
  ).all(taskId);
}

// -- Task-driven child agents --

export function claimTask(taskId, assignee, agentPort) {
  const db = getDb();
  db.prepare(
    "UPDATE tasks SET status = 'in_progress', assignee = ?, agent_port = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(assignee, agentPort, taskId);
  return getTask(taskId);
}

export function completeTaskWithResult(taskId, result) {
  const db = getDb();
  db.prepare(
    "UPDATE tasks SET status = 'done', result = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(result, taskId);
  const task = getTask(taskId);
  // Auto-complete parent task if all subtasks done/skipped
  if (task && task.parent_task_id) {
    autoCompleteParent(task.parent_task_id);
  }
  // Auto-complete goal if all top-level tasks done/skipped
  if (task && task.goal_id) {
    const stats = getTaskStats(task.goal_id);
    if (stats.pending === 0 && stats.in_progress === 0) {
      completeGoal(task.goal_id);
    }
  }
  return task;
}

export function failTask(taskId, reason) {
  const db = getDb();
  db.prepare(
    "UPDATE tasks SET status = 'skipped', result = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(reason || "failed", taskId);
  const task = getTask(taskId);
  // Auto-complete parent task if all subtasks done/skipped
  if (task && task.parent_task_id) {
    autoCompleteParent(task.parent_task_id);
  }
  // Auto-complete goal if all top-level tasks done/skipped
  if (task && task.goal_id) {
    const stats = getTaskStats(task.goal_id);
    if (stats.pending === 0 && stats.in_progress === 0) {
      completeGoal(task.goal_id);
    }
  }
  return task;
}

/** Auto-complete parent when all subtasks are done/skipped */
function autoCompleteParent(parentTaskId) {
  const subs = getSubtasks(parentTaskId);
  if (!subs.length) return;
  const allDone = subs.every(s => s.status === "done" || s.status === "skipped");
  if (allDone) {
    const doneCount = subs.filter(s => s.status === "done").length;
    const result = `All ${subs.length} subtasks completed (${doneCount} done, ${subs.length - doneCount} skipped)`;
    getDb().prepare(
      "UPDATE tasks SET status = 'done', result = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(result, parentTaskId);
    // Cascade: check if goal should auto-complete too
    const parent = getTask(parentTaskId);
    if (parent && parent.goal_id) {
      const goalStats = getTaskStats(parent.goal_id);
      if (goalStats.pending === 0 && goalStats.in_progress === 0) {
        completeGoal(parent.goal_id);
      }
    }
  }
}

export function getTasksByGoalAndStatus(goalId, statuses) {
  const db = getDb();
  const placeholders = statuses.map(() => "?").join(",");
  return db.prepare(
    `SELECT * FROM tasks WHERE goal_id = ? AND status IN (${placeholders}) ORDER BY priority DESC, id ASC`
  ).all(goalId, ...statuses);
}

// -- Dashboard --

export function getDashboard() {
  const db = getDb();
  const goals = db.prepare(
    "SELECT * FROM goals WHERE status = 'active' ORDER BY created_at DESC"
  ).all();
  if (!goals.length) return [];

  // Batch: fetch all tasks for active goals in one query
  const goalIds = goals.map(g => g.id);
  const placeholders = goalIds.map(() => "?").join(",");
  const allTasks = db.prepare(
    `SELECT * FROM tasks WHERE goal_id IN (${placeholders}) ORDER BY priority DESC, id ASC`
  ).all(...goalIds);

  // Group tasks by goal_id
  const tasksByGoal = new Map();
  for (const t of allTasks) {
    if (!tasksByGoal.has(t.goal_id)) tasksByGoal.set(t.goal_id, []);
    tasksByGoal.get(t.goal_id).push(t);
  }

  return goals.map(g => {
    const tasks = tasksByGoal.get(g.id) || [];
    return {
      ...g,
      tasks,
      stats: {
        total: tasks.length,
        pending: tasks.filter(t => t.status === "pending").length,
        in_progress: tasks.filter(t => t.status === "in_progress").length,
        done: tasks.filter(t => t.status === "done").length,
        skipped: tasks.filter(t => t.status === "skipped").length,
      },
    };
  });
}

// -- Conversion helpers: goal+tasks → plan format (for store/UI compatibility) --

export function goalToPlan(goal, tasks) {
  if (!goal) return null;
  // Batch-fetch all subtasks for this goal in one query (avoids N+1)
  const allSubs = getDb().prepare(
    "SELECT * FROM tasks WHERE goal_id = ? AND parent_task_id IS NOT NULL ORDER BY id ASC"
  ).all(goal.id);
  const subsByParent = new Map();
  for (const s of allSubs) {
    if (!subsByParent.has(s.parent_task_id)) subsByParent.set(s.parent_task_id, []);
    subsByParent.get(s.parent_task_id).push(s);
  }

  const topLevel = tasks.map(t => ({
    id: t.id,
    title: t.title,
    description: t.description,
    status: t.status,
    result: t.result,
    subtasks: (subsByParent.get(t.id) || []).map(s => ({
      id: s.id,
      title: s.title,
      status: s.status,
      result: s.result,
    })),
  }));
  return {
    goal: goal.title,
    goalId: goal.id,
    project: goal.project,
    created: goal.created_at,
    tasks: topLevel,
  };
}

/** Alias for getActivePlan — used throughout codebase */
export function syncPlanToStore(store) {
  return getActivePlan(store);
}

// -- Reminders (tasks with next_run) --

export function createReminder(title, nextRun, repeat = null, goalId = null, scope = "session") {
  const db = getDb();
  const r = db.prepare(
    "INSERT INTO tasks (goal_id, title, status, next_run, repeat, scope) VALUES (?, ?, 'pending', ?, ?, ?)"
  ).run(goalId, title, nextRun, repeat, scope);
  return getTask(r.lastInsertRowid);
}

export function getDueReminders() {
  return getDb().prepare(
    "SELECT * FROM tasks WHERE next_run IS NOT NULL AND next_run <= datetime('now') AND status IN ('pending', 'in_progress') ORDER BY next_run ASC"
  ).all();
}

export function fireReminder(id, repeat) {
  const db = getDb();
  if (repeat) {
    // Recurring: advance next_run by interval
    const ms = parseRepeat(repeat);
    if (ms) {
      const next = new Date(Date.now() + ms).toISOString();
      db.prepare(
        "UPDATE tasks SET next_run = ?, updated_at = datetime('now') WHERE id = ?"
      ).run(next, id);
      return getTask(id);
    }
  }
  // One-time: mark done
  db.prepare(
    "UPDATE tasks SET status = 'done', next_run = NULL, updated_at = datetime('now') WHERE id = ?"
  ).run(id);
  return getTask(id);
}

export function cancelReminder(id) {
  const db = getDb();
  db.prepare(
    "UPDATE tasks SET status = 'skipped', next_run = NULL, updated_at = datetime('now') WHERE id = ?"
  ).run(id);
  return getTask(id);
}

export function listReminders() {
  return getDb().prepare(
    "SELECT * FROM tasks WHERE next_run IS NOT NULL AND status IN ('pending', 'in_progress') ORDER BY next_run ASC"
  ).all();
}

export function listRecentFired(hours = 24) {
  return getDb().prepare(
    "SELECT * FROM tasks WHERE next_run IS NULL AND repeat IS NULL AND status = 'done' AND updated_at >= datetime('now', ? || ' hours') ORDER BY updated_at DESC"
  ).all(-hours);
}

function parseRepeat(repeat) {
  const match = repeat.match(/^(\d+)\s*(s|m|h|d|w)$/i);
  if (!match) return null;
  const value = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  const multipliers = { s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 };
  return value * multipliers[unit];
}

/**
 * Single source of truth: read focused plan from SQLite, update store, return plan.
 * Call this everywhere instead of reading store.plan directly.
 * With multi-goal: returns focused goal's plan (or most recent active).
 */
export function getActivePlan(store) {
  const sessionId = store ? store.getState().sessionId : null;
  const goal = getActiveGoal(null, sessionId);
  if (!goal) {
    if (store) store.getState().setPlan(null);
    return null;
  }
  const tasks = getTasksByGoal(goal.id);
  const plan = goalToPlan(goal, tasks);
  if (store) store.getState().setPlan(plan);
  return plan;
}

/**
 * Get all active plans with stats (for multi-goal prompt injection).
 * Returns: [{goal, goalId, project, taskStats}, ...]
 */
export function getAllActivePlans() {
  const db = getDb();
  // Single query for all active goals with stats (avoids N+1)
  const rows = db.prepare(`
    SELECT g.id as goalId, g.title as goal, g.project,
      COUNT(t.id) as total,
      SUM(CASE WHEN t.status = 'pending' THEN 1 ELSE 0 END) as pending,
      SUM(CASE WHEN t.status = 'in_progress' THEN 1 ELSE 0 END) as in_progress,
      SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END) as done,
      SUM(CASE WHEN t.status = 'skipped' THEN 1 ELSE 0 END) as skipped
    FROM goals g LEFT JOIN tasks t ON t.goal_id = g.id AND t.parent_task_id IS NULL
    WHERE g.status = 'active'
    GROUP BY g.id
    ORDER BY g.created_at DESC
  `).all();
  return rows.map(r => ({
    goalId: r.goalId,
    goal: r.goal,
    project: r.project,
    stats: { total: r.total, pending: r.pending, in_progress: r.in_progress, done: r.done, skipped: r.skipped },
  }));
}

/**
 * Aggregate stats across all projects or a specific project.
 */
export function getProjectStats(project = null) {
  const db = getDb();
  // Exclude subtasks from counts (parent_task_id IS NULL)
  if (project) {
    return db.prepare(`
      SELECT
        COUNT(DISTINCT g.id) as goals,
        COUNT(t.id) as tasks,
        SUM(CASE WHEN t.status = 'pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN t.status = 'in_progress' THEN 1 ELSE 0 END) as in_progress,
        SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END) as done
      FROM goals g LEFT JOIN tasks t ON t.goal_id = g.id AND t.parent_task_id IS NULL
      WHERE g.status = 'active' AND g.project = ?
    `).get(project);
  }
  return db.prepare(`
    SELECT
      g.project,
      COUNT(DISTINCT g.id) as goals,
      COUNT(t.id) as tasks,
      SUM(CASE WHEN t.status = 'pending' THEN 1 ELSE 0 END) as pending,
      SUM(CASE WHEN t.status = 'in_progress' THEN 1 ELSE 0 END) as in_progress,
      SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END) as done
    FROM goals g LEFT JOIN tasks t ON t.goal_id = g.id AND t.parent_task_id IS NULL
    WHERE g.status = 'active'
    GROUP BY g.project
  `).all();
}

// -- Day Planning --

/** Mark task(s) for today's focus */
export function setDailyFocus(taskId, date = null) {
  const d = date || new Date().toISOString().slice(0, 10);
  getDb().prepare("UPDATE tasks SET daily_focus = ? WHERE id = ?").run(d, taskId);
}

/** Clear daily focus from a task */
export function clearDailyFocus(taskId) {
  getDb().prepare("UPDATE tasks SET daily_focus = NULL WHERE id = ?").run(taskId);
}

/** Get tasks focused for today (across all goals/projects) */
export function getTodayTasks(date = null) {
  const d = date || new Date().toISOString().slice(0, 10);
  return getDb().prepare(`
    SELECT t.*, g.title as goal_title, g.project
    FROM tasks t LEFT JOIN goals g ON t.goal_id = g.id
    WHERE t.daily_focus = ? AND t.status IN ('pending', 'in_progress')
    ORDER BY t.priority DESC, t.id ASC
  `).all(d);
}

// -- Session GC --

/**
 * Garbage collect stale sessions. Moves tasks from sessions not updated
 * in `days` to _orphaned session. Adds audit note to each moved task.
 * Returns count of orphaned tasks.
 */
export function gcStaleSessions(days = 7) {
  const db = getDb();
  const stale = getStaleSessions(days);
  if (!stale.length) return 0;

  // Ensure _orphaned session exists
  touchSession("_orphaned");

  let orphanedCount = 0;
  for (const session of stale) {
    // Find goals from this session
    const goals = db.prepare(
      "SELECT id FROM goals WHERE session_id = ? AND status = 'active'"
    ).all(session.id);

    for (const goal of goals) {
      // Get tasks that are session-scoped and still active
      const tasks = db.prepare(
        "SELECT id, title FROM tasks WHERE goal_id = ? AND scope = 'session' AND status IN ('pending', 'in_progress')"
      ).all(goal.id);

      for (const task of tasks) {
        addNote(task.id, `[GC] Moved from session ${session.id} to _orphaned (stale ${days}+ days)`);
        // Change scope to prevent re-GC
        db.prepare("UPDATE tasks SET scope = 'project' WHERE id = ? AND scope = 'session'").run(task.id);
        orphanedCount++;
      }

      // Move goal to _orphaned session
      db.prepare("UPDATE goals SET session_id = '_orphaned' WHERE id = ?").run(goal.id);
    }

    // Delete stale session record
    db.prepare("DELETE FROM sessions WHERE id = ?").run(session.id);
  }

  return orphanedCount;
}
