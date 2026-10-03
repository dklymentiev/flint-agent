// Task planning tools for Flint — backed by SQLite
// AI creates plans for complex tasks and tracks progress persistently

import {
  createGoal, getGoal, getActiveGoal, getActiveGoals, completeGoal, abandonGoal, listGoals,
  createTask, createSubtask, getSubtasks, getTasksByGoal, updateTaskStatus, getTaskStats,
  linkFile, addNote, getTaskFiles, getTaskNotes, getTask,
  goalToPlan, syncPlanToStore,
  createReminder, listReminders,
  touchSession, setFocusedGoal, getFocusedGoal,
  getAllActivePlans, getProjectStats,
  setDailyFocus, clearDailyFocus, getTodayTasks,
} from "../tasks/queries.js";

function parseDelay(delay) {
  const match = delay.match(/^(\d+)\s*(s|m|h|d|w)$/i);
  if (!match) return null;
  const value = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  const multipliers = { s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 };
  return value * multipliers[unit];
}

export function createTaskTools({ getStore }) {
  function sync() {
    return syncPlanToStore(getStore());
  }

  const tools = [
    {
      type: "function",
      function: {
        name: "create_plan",
        description:
          "Create a persistent plan for a complex multi-step task. " +
          "Stored in SQLite — survives restarts. " +
          "Multiple plans can coexist. New plan becomes the focused goal.",
        parameters: {
          type: "object",
          properties: {
            goal: {
              type: "string",
              description: "The overall goal of the plan",
            },
            project: {
              type: "string",
              description: "Project tag (e.g. 'flint', 'website'). Default: 'default'",
            },
            tasks: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  title: { type: "string", description: "Short task title" },
                  description: { type: "string", description: "Optional details" },
                  priority: { type: "number", description: "Priority (higher = first). Default 0" },
                },
                required: ["title"],
              },
              description: "List of tasks to complete",
            },
          },
          required: ["goal", "tasks"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "update_task",
        description:
          "Update a task by its global ID (shown in [#ID] in plan output). " +
          "For the focused goal, relative index (1, 2, 3...) also works.",
        parameters: {
          type: "object",
          properties: {
            id: {
              type: "number",
              description: "Task ID (global #ID or relative 1..N within focused goal)",
            },
            status: {
              type: "string",
              enum: ["done", "in_progress", "skipped"],
              description: "New status for the task",
            },
            result: {
              type: "string",
              description: "Optional note about the result",
            },
          },
          required: ["id", "status"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "list_tasks",
        description:
          "Show the current plan with task statuses from SQLite. " +
          "Use this to review progress on the current plan.",
        parameters: {
          type: "object",
          properties: {},
        },
      },
    },
    {
      type: "function",
      function: {
        name: "add_task",
        description:
          "Add a standalone task (with optional schedule). " +
          "Use for reminders, recurring jobs, or tasks outside a plan. " +
          "Examples: 'check email every 5m', 'remind me at 15:00', 'buy groceries'.",
        parameters: {
          type: "object",
          properties: {
            title: { type: "string", description: "Task title" },
            description: { type: "string", description: "Optional details" },
            next_run: {
              type: "string",
              description: 'When to fire: delay ("5m","1h","2d") or ISO datetime. Omit for non-scheduled tasks.',
            },
            repeat: {
              type: "string",
              description: 'Repeat interval: "5m","1h","1d","1w". Omit for one-time.',
            },
            project: { type: "string", description: "Project tag. Default: 'default'" },
            scope: {
              type: "string",
              enum: ["session", "project", "global"],
              description: "Scope: session (dies with session), project (survives sessions), global (always visible). Recurring tasks auto-set to global.",
            },
          },
          required: ["title"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "add_task_note",
        description: "Add a note/log entry to a specific task.",
        parameters: {
          type: "object",
          properties: {
            task_id: { type: "number", description: "Task ID" },
            note: { type: "string", description: "Note text" },
          },
          required: ["task_id", "note"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "link_task_file",
        description: "Link a file to a task (created, modified, or related).",
        parameters: {
          type: "object",
          properties: {
            task_id: { type: "number", description: "Task ID" },
            path: { type: "string", description: "File path" },
            role: {
              type: "string",
              enum: ["created", "modified", "related"],
              description: "How the file relates to the task. Default: related",
            },
          },
          required: ["task_id", "path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "create_subtask",
        description:
          "Add subtask(s) to an existing task. Parent auto-completes when all subtasks are done. Max 2 levels (task -> subtask).",
        parameters: {
          type: "object",
          properties: {
            parent_id: { type: "number", description: "Parent task ID (global #ID)" },
            subtasks: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  title: { type: "string", description: "Subtask title" },
                  description: { type: "string", description: "Optional details" },
                },
                required: ["title"],
              },
              description: "List of subtasks to add",
            },
          },
          required: ["parent_id", "subtasks"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "focus_goal",
        description:
          "Switch focus to a different active goal. The focused goal's tasks are shown in detail in the prompt.",
        parameters: {
          type: "object",
          properties: {
            goal_id: { type: "number", description: "Goal ID to focus on" },
          },
          required: ["goal_id"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "task_stats",
        description:
          "Get overview stats without loading all tasks. " +
          "Shows per-project or per-goal counts (pending, in_progress, done). " +
          "Use for dashboard view before drilling into details.",
        parameters: {
          type: "object",
          properties: {
            project: { type: "string", description: "Filter by project. Omit for all projects." },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "list_goals",
        description:
          "List all goals (active, completed, abandoned). " +
          "Use to find goal IDs for focus_goal or to review history.",
        parameters: {
          type: "object",
          properties: {
            status: {
              type: "string",
              enum: ["active", "completed", "abandoned"],
              description: "Filter by status. Omit for all.",
            },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "today",
        description:
          "Show tasks planned for today, or set tasks for today's focus. " +
          "Without task_ids: shows today's tasks across all goals. " +
          "With task_ids: marks those tasks for today.",
        parameters: {
          type: "object",
          properties: {
            task_ids: {
              type: "array",
              items: { type: "number" },
              description: "Task IDs to mark for today. Omit to just view today's tasks.",
            },
          },
        },
      },
    },
  ];

  function resolveTaskId(id) {
    const activeGoal = getActiveGoal();
    if (activeGoal) {
      const goalTasks = getTasksByGoal(activeGoal.id);
      if (id >= 1 && id <= goalTasks.length) {
        return goalTasks[id - 1].id;
      }
    }
    return id;
  }

  const handlers = {
    async create_plan({ goal, tasks, project }) {
      if (!tasks || tasks.length === 0) {
        return "Error: tasks array is empty. You must provide at least one task with a title. Example: tasks: [{title: 'Step 1'}, {title: 'Step 2'}]";
      }

      const sessionId = getStore().getState().sessionId;
      touchSession(sessionId);

      // Multi-goal: do NOT abandon previous goals
      const g = createGoal(goal, project || "default", sessionId);

      for (const t of tasks) {
        const title = t.title || t.description || t.name || "Untitled task";
        createTask(g.id, title, t.description || null, t.priority || 0);
      }

      // Auto-focus the new goal
      setFocusedGoal(sessionId, g.id);

      sync();
      const createdTasks = getTasksByGoal(g.id);
      const taskList = createdTasks.map((t, i) => `  ${i + 1}. [#${t.id}] ${t.title}`).join("\n");
      return `Plan created: ${goal} [goal #${g.id}] (focused)\nTasks:\n${taskList}`;
    },

    async update_task({ id, status, result }) {
      const sessionId = getStore().getState().sessionId;
      touchSession(sessionId);

      // Resolve relative task index (1-based) within focused goal
      const resolvedId = resolveTaskId(id);
      const task = updateTaskStatus(resolvedId, status, result || null);
      if (!task) return `Error: task ${id} not found (resolved to #${resolvedId})`;

      // Check if all tasks in the goal are done/skipped
      if (task.goal_id) {
        const stats = getTaskStats(task.goal_id);
        if (stats.pending === 0 && stats.in_progress === 0) {
          completeGoal(task.goal_id);
        }
      }

      sync();
      return `Task #${resolvedId}: ${task.title} -> ${status}${result ? ` (${result})` : ""}`;
    },

    async list_tasks() {
      const sessionId = getStore().getState().sessionId;
      const plan = sync(); // focused goal
      const allPlans = getAllActivePlans();
      const scheduled = listReminders();
      const parts = [];

      // Focused goal — full detail
      if (plan) {
        parts.push(formatPlanForPrompt(plan) + " [FOCUSED]");
      }

      // Other active goals — one-line summaries
      const focusedId = plan ? plan.goalId : null;
      for (const p of allPlans) {
        if (p.goalId === focusedId) continue;
        const s = p.stats;
        parts.push(`[goal #${p.goalId}] ${p.goal} (${p.project}) — ${s.done}/${s.total} done, ${s.pending} pending`);
      }

      if (scheduled.length) {
        parts.push("SCHEDULED:");
        for (const t of scheduled) {
          const repeatTag = t.repeat ? ` [every ${t.repeat}]` : "";
          parts.push(`  [#${t.id}] ${t.title} — next: ${t.next_run}${repeatTag}`);
        }
      }
      if (!parts.length) return "No active tasks. Use create_plan or add_task to create.";
      return parts.join("\n");
    },

    async add_task({ title, description, next_run, repeat, project, scope }) {
      let nextRunISO = null;
      if (next_run) {
        const ms = parseDelay(next_run);
        if (ms) {
          nextRunISO = new Date(Date.now() + ms).toISOString();
        } else {
          const parsed = new Date(next_run);
          if (!isNaN(parsed.getTime())) {
            nextRunISO = parsed.toISOString();
          } else {
            return `Error: invalid next_run "${next_run}". Use delay ("5m","1h") or ISO datetime.`;
          }
        }
      }
      if (repeat) {
        const ms = parseDelay(repeat);
        if (!ms) return `Error: invalid repeat "${repeat}". Use "5m","1h","1d","1w".`;
        if (!nextRunISO) {
          // If repeat but no next_run, fire first time after one interval
          nextRunISO = new Date(Date.now() + ms).toISOString();
        }
      }

      // Create under active goal or standalone (goal_id = null)
      let goalId = null;
      const active = getActiveGoal(project || "default");
      if (active) goalId = active.id;

      // Determine scope: recurring = global, one-time with repeat = project, else session
      const taskScope = scope || (repeat ? "global" : "session");
      const task = createReminder(title, nextRunISO, repeat || null, goalId, taskScope);

      const parts = [`Task #${task.id}: "${title}" [${taskScope}]`];
      if (nextRunISO) parts.push(`next run: ${nextRunISO}`);
      if (repeat) parts.push(`repeats: every ${repeat}`);
      return parts.join(" | ");
    },

    async add_task_note({ task_id, note }) {
      const resolved = resolveTaskId(task_id);
      addNote(resolved, note);
      return `Note added to task ${task_id}`;
    },

    async link_task_file({ task_id, path, role }) {
      const resolved = resolveTaskId(task_id);
      linkFile(resolved, path, role || "related");
      return `File linked to task ${task_id}: ${path} (${role || "related"})`;
    },

    async create_subtask({ parent_id, subtasks }) {
      if (!subtasks || subtasks.length === 0) {
        return "Error: subtasks array is empty.";
      }
      const parent = getTask(parent_id);
      if (!parent) return `Error: task #${parent_id} not found`;
      // Prevent 3+ levels
      if (parent.parent_task_id) {
        return `Error: task #${parent_id} is already a subtask. Max 2 levels allowed.`;
      }

      const created = [];
      for (const st of subtasks) {
        const sub = createSubtask(parent_id, st.title, st.description || null);
        if (sub) created.push(sub);
      }

      sync();
      const lines = created.map(s => `  [#${s.id}] ${s.title}`).join("\n");
      return `Added ${created.length} subtask(s) to task #${parent_id} "${parent.title}":\n${lines}`;
    },

    async focus_goal({ goal_id }) {
      const sessionId = getStore().getState().sessionId;
      const goal = getGoal(goal_id);
      if (!goal) return `Error: goal #${goal_id} not found`;
      if (goal.status !== "active") return `Error: goal #${goal_id} is ${goal.status}, not active`;
      setFocusedGoal(sessionId, goal_id);
      sync();
      const tasks = getTasksByGoal(goal_id);
      const stats = getTaskStats(goal_id);
      return `Focused on goal #${goal_id}: ${goal.title} (${goal.project})\n${stats.done}/${stats.total} done, ${stats.pending} pending, ${stats.in_progress} in progress`;
    },

    async task_stats({ project } = {}) {
      if (project) {
        const stats = getProjectStats(project);
        return `Project "${project}": ${stats.goals} goals, ${stats.tasks} tasks (${stats.done} done, ${stats.pending} pending, ${stats.in_progress} in progress)`;
      }
      const rows = getProjectStats();
      if (!rows.length) return "No active goals in any project.";
      const lines = rows.map(r =>
        `  ${r.project}: ${r.goals} goals, ${r.tasks} tasks (${r.done} done, ${r.pending} pending)`
      );
      return `Active projects:\n${lines.join("\n")}`;
    },

    async today({ task_ids } = {}) {
      const todayDate = new Date().toISOString().slice(0, 10);
      if (task_ids && task_ids.length > 0) {
        const invalid = task_ids.filter(tid => !getTask(tid));
        if (invalid.length) return `Error: task(s) not found: ${invalid.join(", ")}`;
        for (const tid of task_ids) {
          setDailyFocus(tid, todayDate);
        }
        const tasks = getTodayTasks(todayDate);
        const lines = tasks.map(t =>
          `  [#${t.id}] ${t.title} (${t.project || "default"}: ${t.goal_title || "standalone"})`
        );
        return `Marked ${task_ids.length} task(s) for today (${todayDate}).\nToday's tasks:\n${lines.join("\n")}`;
      }
      // View mode
      const tasks = getTodayTasks(todayDate);
      if (!tasks.length) return `No tasks planned for today (${todayDate}). Use today({task_ids: [...]}) to set tasks.`;
      const lines = tasks.map(t => {
        const icon = STATUS_ICONS[t.status] || "o";
        return `  [#${t.id}] ${icon} ${t.title} (${t.project || "default"}: ${t.goal_title || "standalone"})`;
      });
      return `Today (${todayDate}):\n${lines.join("\n")}`;
    },

    async list_goals({ status } = {}) {
      const goals = listGoals(status || null);
      if (!goals.length) return status ? `No ${status} goals.` : "No goals.";
      const sessionId = getStore().getState().sessionId;
      const focused = getFocusedGoal(sessionId);
      const focusedId = focused ? focused.id : null;
      const lines = goals.map(g => {
        const tag = g.id === focusedId ? " [FOCUSED]" : "";
        const stats = g.status === "active" ? (() => {
          const s = getTaskStats(g.id);
          return ` — ${s.done}/${s.total} done`;
        })() : "";
        return `  [#${g.id}] ${g.title} (${g.project}) [${g.status}]${stats}${tag}`;
      });
      return `Goals:\n${lines.join("\n")}`;
    },
  };

  return { tools, handlers };
}

const STATUS_ICONS = {
  done: "+",
  in_progress: ">",
  pending: "o",
  skipped: "-",
};

export function formatPlanForPrompt(plan) {
  if (!plan) return "";
  const lines = [`[PLAN #${plan.goalId || "?"}] Goal: ${plan.goal} (project: ${plan.project || "default"})`];
  for (const t of plan.tasks) {
    const icon = STATUS_ICONS[t.status] || "o";
    let line = `[#${t.id}] ${icon} ${t.title}`;
    if (t.result) line += ` - ${t.result}`;
    lines.push(line);
    // Subtasks indented
    if (t.subtasks && t.subtasks.length) {
      for (const s of t.subtasks) {
        const sIcon = STATUS_ICONS[s.status] || "o";
        let sLine = `  [#${s.id}] ${sIcon} ${s.title}`;
        if (s.result) sLine += ` - ${s.result}`;
        lines.push(sLine);
      }
    }
  }
  return lines.join("\n");
}
