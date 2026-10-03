// An autonomous run driven through the bus, against a provider that starts
// refusing part way through.
//
// Written from the symptom, like the benchmark gates: the fake agent returns
// exactly what a real dead account returns, and the test asks only two things.
// Did the run stop, and was the operator told the truth about why. It does not
// say where the check belongs or which field carries the answer.
//
// The provider dies on a LATER turn, never the first one, for the same reason
// the /auto gate does: a guard on the opening turn alone would pass and do
// nothing for a key that expires in the middle of the night.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";

let testDb;

vi.mock("../../src/tasks/db.js", () => ({
  getDb: () => testDb,
  closeDb: () => {},
}));

vi.mock("../../src/logging/logger.js", () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}));

// The agent under test. Each entry is one turn's result.
//
// It calls resetFlow() first because the real one does: runAgent starts every
// invocation with it (agent.js:248), which is what clears the user-interrupt
// flag the drain loop raises on each non-self-continue message. A mock without
// it stops the run after one turn and invents a defect that is not there.
const agent = { turns: [], calls: 0 };
vi.mock("../../src/message-handler.js", () => ({
  processMessage: vi.fn(async () => {
    const { resetFlow } = await import("../../src/agent/flow-controller.js");
    resetFlow();
    const i = agent.calls++;
    const r = agent.turns[Math.min(i, agent.turns.length - 1)];
    return typeof r === "function" ? r(i) : r;
  }),
  handlePendingAction: async () => {},
}));

vi.mock("../../src/ui/header.js", () => ({
  userMsgLine: () => {},
  INDENT: "  ",
  formatToolArgs: () => "",
}));
vi.mock("../../src/tools/permissions.js", () => ({
  bulkSetPermission: () => {},
  setUnattended: () => {},
}));
vi.mock("../../src/agent/supervisor.js", () => ({
  setSupervisorEnabled: () => {},
}));
vi.mock("../../src/agent/learning.js", () => ({
  extractLearnings: () => {},
}));
vi.mock("../../src/config.js", () => ({
  config: { apiAutoApprove: true },
}));

// Everything the operator is shown goes through addLine, so that is where the
// test looks for the explanation. It is the terminal, not a field name.
const shown = [];
const storeState = {
  sessionId: "bus-test",
  plan: null,
  messages: [],
  addLine: (l) => shown.push(String(l)),
  incrementQueue: () => {},
  decrementQueue: () => {},
  setLastSummary: () => {},
  setPlan: (p) => { storeState.plan = p; },
};
vi.mock("../../src/store/index.js", () => ({
  store: {
    getState: () => storeState,
    setState: (patch) => Object.assign(storeState, patch),
  },
}));

const bus = await import("../../src/bus/index.js");
const drain = await import("../../src/bus/drain-loop.js");
const Q = await import("../../src/tasks/queries.js");
const { app } = await import("../../src/app-state.js");
const { resetFlow } = await import("../../src/agent/flow-controller.js");

function createTestDb() {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS message_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel TEXT NOT NULL, content TEXT NOT NULL, priority INTEGER DEFAULT 5,
      source TEXT, metadata TEXT, status TEXT DEFAULT 'pending', session_id TEXT,
      created_at TEXT DEFAULT (datetime('now')), processed_at TEXT, result TEXT
    );
    CREATE TABLE IF NOT EXISTS goals (
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL,
      project TEXT DEFAULT 'default',
      status TEXT DEFAULT 'active' CHECK(status IN ('active','completed','abandoned')),
      session_id TEXT, created_at TEXT DEFAULT (datetime('now')), completed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, goal_id INTEGER REFERENCES goals(id) ON DELETE CASCADE,
      title TEXT NOT NULL, description TEXT,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending','in_progress','done','skipped')),
      priority INTEGER DEFAULT 0, result TEXT, next_run TEXT, repeat TEXT, assignee TEXT,
      agent_port INTEGER, scope TEXT DEFAULT 'session', parent_task_id INTEGER REFERENCES tasks(id),
      daily_focus TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS task_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      path TEXT NOT NULL, role TEXT DEFAULT 'related', added_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS task_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      note TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, created_at TEXT DEFAULT (datetime('now')),
      last_updated TEXT DEFAULT (datetime('now')), focused_goal_id INTEGER REFERENCES goals(id)
    );
  `);
  return db;
}

const healthy = (n) => ({
  text: `did step ${n}`,
  stats: { cost: 0.001 },
  stop_reason: "done",
  toolCalls: [{ name: "update_task", arguments: { id: n } }],
});

beforeEach(() => {
  testDb = createTestDb();
  agent.turns = [];
  agent.calls = 0;
  shown.length = 0;
  app.autonomous = true;
  app.mcpReady = true;
  app.queueAborted = false;
  app.apiGoalId = null;
  resetFlow();
  drain.resetAutonomous();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  drain.resetAutonomous();
  app.autonomous = false;
  if (testDb) { testDb.close(); testDb = null; }
});

/**
 * Let the bus run for a fixed stretch of time and count what it did.
 *
 * Deliberately no early exit. A harness that decides for itself when the run
 * is over ends up measuring the harness: the first version stopped as soon as
 * nothing was queued and reported three turns for a run that had not finished
 * giving up, which would have scored a broken loop as a working one.
 */
async function runBus(firstMessage, { ticks = 20 } = {}) {
  bus.push({ channel: "autonomous", content: firstMessage, priority: 5, source: "operator" });
  drain.notify();
  for (let i = 0; i < ticks; i++) {
    await vi.advanceTimersByTimeAsync(4000);
  }
}

describe("an autonomous run on the bus, against a provider that refuses", () => {
  const DIES_AT = 2; // zero-based: turns 0 and 1 work, the rest do not

  for (const [reason, sample] of [
    ["quota", "[QUOTA] Insufficient credits. Top up credits with the provider."],
    ["auth", "[AUTH] 401 Unauthorized. Run /key to update the API key."],
  ]) {
    it(`stops, and says the provider is why, on ${reason}`, async () => {
      const goal = Q.createGoal("Night work");
      Q.createTask(goal.id, "Step 1");
      Q.createTask(goal.id, "Step 2");
      Q.createTask(goal.id, "Step 3");

      agent.turns = [
        (i) => (i < DIES_AT
          ? healthy(i)
          : { text: sample, stats: { cost: 0.0004 }, stop_reason: reason, toolCalls: [] }),
      ];

      await runBus("work through the plan");
      if (process.env.BUS_DEBUG) console.log(`[${reason}] turns=${agent.calls} shown=${JSON.stringify(shown)}`);

      // Criterion 1: it found out on turn DIES_AT. Two more turns is slack.
      expect(agent.calls).toBeLessThanOrEqual(DIES_AT + 2);

      // Criterion 2: the operator is told the provider refused, and can tell
      // that apart from a stuck agent, a spent budget or a finished plan.
      const said = shown.join(" ").toLowerCase();
      expect(said).toMatch(/quota|credit|auth|api key|provider|rate.?limit/);
      expect(said).not.toMatch(/no progress|identical/);
    });
  }

  it("carries on through a rate limit instead of ending the night's work", async () => {
    const goal = Q.createGoal("Throttled night");
    Q.createTask(goal.id, "Step 1");
    Q.createTask(goal.id, "Step 2");

    agent.turns = [
      (i) => {
        if (i === 1) {
          return { text: "[RATE-LIMIT] 429", stats: { cost: 0 }, stop_reason: "rate-limit", retryAfter: 1, toolCalls: [] };
        }
        if (i === 2) {
          for (const t of Q.getTasksByGoal(goal.id)) Q.updateTaskStatus(t.id, "done");
        }
        return healthy(i);
      },
    ];

    await runBus("work through the plan");

    // It did not treat "not now" as "not ever".
    expect(agent.calls).toBeGreaterThan(2);
    const said = shown.join(" ").toLowerCase();
    // It went through the waiting path rather than sailing past by accident,
    // and it did not blame the agent for being served nothing.
    expect(said).toMatch(/rate limit/);
    expect(said).not.toMatch(/no progress|identical/);
  });

  it("gives up when the rate limit never lifts, and says that is why", async () => {
    const goal = Q.createGoal("Capped night");
    Q.createTask(goal.id, "Step 1");
    Q.createTask(goal.id, "Step 2");

    agent.turns = [
      (i) => (i === 0
        ? healthy(i)
        : { text: "[RATE-LIMIT] 429", stats: { cost: 0 }, stop_reason: "rate-limit", retryAfter: null, toolCalls: [] }),
    ];

    await runBus("work through the plan");

    // The first refusal plus a bounded number of retries, not an all-night loop.
    expect(agent.calls).toBeLessThanOrEqual(6);
    const said = shown.join(" ").toLowerCase();
    expect(said).toMatch(/rate limit/);
    expect(said).not.toMatch(/no progress|identical/);
  });

  it("leaves a healthy run alone", async () => {
    const goal = Q.createGoal("Good night");
    const t1 = Q.createTask(goal.id, "Step 1");
    const t2 = Q.createTask(goal.id, "Step 2");

    agent.turns = [
      (i) => {
        if (i === 0) Q.updateTaskStatus(t1.id, "done");
        if (i === 1) Q.updateTaskStatus(t2.id, "done");
        return healthy(i);
      },
    ];

    await runBus("work through the plan");

    // The plan got worked, and nothing blamed the provider for it.
    expect(agent.calls).toBeGreaterThanOrEqual(2);
    const said = shown.join(" ").toLowerCase();
    expect(said).not.toMatch(/quota|credit|401|unauthorized/);
  });
});
