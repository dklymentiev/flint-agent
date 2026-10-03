// Tests for multi-agent system tools (Phase R7)
// Validates: spawn_agent, ask_agent, list_agents, wait_tasks handlers
//
// NOTE: _childAgents is a module-level Map that persists across tests within the
// same file. Tests use unique ports and account for accumulated state.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createMockStore } from "../../helpers/mock-store.js";
import { activeChildren } from "../../../src/tools/process-tools.js";
import { EventEmitter } from "node:events";

// Mock UI output functions
vi.mock("../../../src/ui/output.js", () => ({
  printChildAgent: vi.fn(),
  printChildSpawn: vi.fn(),
  printChildEvent: vi.fn(),
  printProcessStart: vi.fn(),
  printProcessEnd: vi.fn(),
  printProcessSummary: vi.fn(),
  setProcessStream: vi.fn(),
}));

// Mock filesystem (getDeniedPaths)
vi.mock("../../../src/tools/filesystem.js", () => ({
  getDeniedPaths: vi.fn(() => []),
}));

// Mock task queries
vi.mock("../../../src/tasks/queries.js", () => ({
  getTask: vi.fn(),
  getTasksByGoalAndStatus: vi.fn(() => []),
  getTaskStats: vi.fn(),
}));

// Mock child_process.spawn -- capture calls without launching real processes
const mockSpawn = vi.fn();
vi.mock("node:child_process", () => ({
  spawn: (...args) => mockSpawn(...args),
}));

// Mock config with controlled values -- high limit so tests don't interfere
vi.mock("../../../src/config.js", () => ({
  config: {
    maxChildAgents: 50, // high limit to avoid cross-test interference
    childIdleTimeout: 60,
    childCleanupDelay: 100,
    projectRoot: "/tmp/flint-test",
    port: 3000,
    provider: "openrouter",
    apiKey: "test-key-12345",
  },
}));

let store;
let handlers;
let _fakeChildren = [];

function createFakeChild() {
  const child = new EventEmitter();
  child.pid = Math.floor(Math.random() * 90000) + 10000;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  child.unref = vi.fn();
  _fakeChildren.push(child);
  return child;
}

beforeEach(async () => {
  store = createMockStore();
  activeChildren.clear();
  mockSpawn.mockReset();
  _fakeChildren = [];

  // Default: return a fake child process
  mockSpawn.mockImplementation(() => createFakeChild());

  // Dynamic import to ensure mocks are applied
  const mod = await import("../../../src/tools/agent-tools.js");
  handlers = mod.createAgentHandlers(store);
});

afterEach(() => {
  activeChildren.clear();
  // Mark all fake children as stopped so they don't count toward limits
  for (const child of _fakeChildren) {
    child.emit("close", 0);
  }
});

// ── spawn_agent ──

describe("spawn_agent", () => {
  it("assigns port from 3010+ range when no port given", async () => {
    const result = await handlers.spawn_agent({ task: "do something" });
    expect(result).toContain("Agent spawned on port");
    const portMatch = result.match(/port (\d+)/);
    expect(portMatch).toBeTruthy();
    expect(parseInt(portMatch[1])).toBeGreaterThanOrEqual(3010);
  });

  it("uses explicitly provided port", async () => {
    const result = await handlers.spawn_agent({ task: "custom port test", port: 4050 });
    expect(result).toContain("port 4050");
  });

  it("passes task description and returns confirmation", async () => {
    const result = await handlers.spawn_agent({ task: "Refactor the logging module" });
    expect(result).toContain("Refactor the logging module");
    expect(result).toContain("ask_agent");
    expect(result).toContain("list_agents");
  });

  it("starts heartbeat monitoring (spawn was called)", async () => {
    const result = await handlers.spawn_agent({ task: "heartbeat test" });
    expect(result).toContain("Agent spawned");
    expect(mockSpawn).toHaveBeenCalled();
  });

  it("respects maxChildAgents limit", async () => {
    // Use a separate config override for this test: re-import with low limit
    const { config } = await import("../../../src/config.js");
    const origMax = config.maxChildAgents;
    config.maxChildAgents = 3;
    try {
      for (let i = 0; i < 3; i++) {
        const r = await handlers.spawn_agent({ task: `limit-task-${i}`, port: 7100 + i });
        expect(r).toContain("Agent spawned");
      }
      // 4th should fail
      const result = await handlers.spawn_agent({ task: "over limit", port: 7200 });
      expect(result).toContain("Error");
      expect(result).toContain("max child agents limit");
    } finally {
      config.maxChildAgents = origMax;
    }
  });

  it("generates pairing secret and passes to child env", async () => {
    await handlers.spawn_agent({ task: "pairing test", port: 6010 });
    expect(mockSpawn).toHaveBeenCalled();
    const lastCall = mockSpawn.mock.calls[mockSpawn.mock.calls.length - 1];
    const env = lastCall[2]?.env;
    expect(env).toBeDefined();
    expect(env.AGENT_PAIRING_SECRET).toBeDefined();
    expect(env.AGENT_PAIRING_SECRET).toMatch(/^[0-9a-f]{64}$/);
  });

  it("passes task_id to child env when provided", async () => {
    await handlers.spawn_agent({ task: "task-driven child", task_id: 42, port: 6020 });
    const lastCall = mockSpawn.mock.calls[mockSpawn.mock.calls.length - 1];
    const env = lastCall[2]?.env;
    expect(env.AGENT_TASK_ID).toBe("42");
  });

  it("does not set AGENT_TASK_ID when task_id not provided", async () => {
    await handlers.spawn_agent({ task: "no task id", port: 6030 });
    const lastCall = mockSpawn.mock.calls[mockSpawn.mock.calls.length - 1];
    const env = lastCall[2]?.env;
    expect(env.AGENT_TASK_ID).toBeUndefined();
  });

  it("filters sensitive API keys from child env", async () => {
    process.env.OPENAI_API_KEY = "secret-openai";
    process.env.ANTHROPIC_API_KEY = "secret-anthropic";
    try {
      await handlers.spawn_agent({ task: "env filter test", port: 6040 });
      const lastCall = mockSpawn.mock.calls[mockSpawn.mock.calls.length - 1];
      const env = lastCall[2]?.env;
      expect(env.OPENROUTER_API_KEY).toBe("test-key-12345");
      expect(env.OPENAI_API_KEY).toBeUndefined();
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    } finally {
      delete process.env.OPENAI_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it("returns pid and process id in result", async () => {
    const result = await handlers.spawn_agent({ task: "pid test", port: 6050 });
    expect(result).toMatch(/pid \d+/);
    expect(result).toMatch(/process #\d+/);
  });

  it("registers process in store", async () => {
    await handlers.spawn_agent({ task: "store registration", port: 6060 });
    const procs = store.getState().processes;
    expect(procs.length).toBeGreaterThan(0);
    const last = procs[procs.length - 1];
    expect(last.cmd).toMatch(/agent@6060/);
  });

  it("sets AGENT_PARENT_PORT in child env", async () => {
    await handlers.spawn_agent({ task: "parent port", port: 6070 });
    const lastCall = mockSpawn.mock.calls[mockSpawn.mock.calls.length - 1];
    const env = lastCall[2]?.env;
    expect(env.AGENT_PARENT_PORT).toBe("3000");
  });
});

// ── ask_agent ──

describe("ask_agent", () => {
  it("returns error when no agent on port", async () => {
    const result = await handlers.ask_agent({ port: 9999, message: "hello" });
    expect(result).toContain("No agent on port 9999");
    expect(result).toContain("list_agents");
  });

  it("returns error when agent has stopped", async () => {
    await handlers.spawn_agent({ task: "short task", port: 5050 });
    // Find the fake child that was spawned for this port
    const lastChild = _fakeChildren[_fakeChildren.length - 1];
    lastChild.emit("close", 0);
    await new Promise((r) => setTimeout(r, 10));

    const result = await handlers.ask_agent({ port: 5050, message: "still there?" });
    expect(result).toContain("stopped");
  });

  it("handles connection refused (fetch error) for starting agent", async () => {
    await handlers.spawn_agent({ task: "fetch test", port: 5060 });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("fetch failed"));
    try {
      const result = await handlers.ask_agent({ port: 5060, message: "hello" });
      // Agent is "starting", ask_agent retries /status 30 times, then gives up
      expect(result).toContain("failed to start");
    } finally {
      globalThis.fetch = originalFetch;
    }
  }, 35000); // allow time for 30 retries

  it("sends HTTP POST to correct port with message", async () => {
    // Mock fetch BEFORE spawning so sendTask() background calls don't interfere
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation(async (url, opts) => {
      if (typeof url === "string" && url.includes("/message")) {
        return { ok: true, json: async () => ({ response: "Task completed successfully" }) };
      }
      return { ok: true }; // /status
    });
    try {
      await handlers.spawn_agent({ task: "http test", port: 5070 });
      const result = await handlers.ask_agent({ port: 5070, message: "check status" });
      expect(result).toContain("Task completed successfully");
      const messageCalls = globalThis.fetch.mock.calls.filter(
        (c) => typeof c[0] === "string" && c[0].includes("/message")
      );
      expect(messageCalls.length).toBeGreaterThanOrEqual(1);
      // Find the ask_agent call (body contains "check status")
      const askCall = messageCalls.find((c) => {
        try { return c[1]?.body?.includes("check status"); } catch { return false; }
      });
      expect(askCall).toBeDefined();
      expect(askCall[0]).toBe("http://127.0.0.1:5070/message");
      expect(askCall[1].method).toBe("POST");
    } finally {
      globalThis.fetch = originalFetch;
    }
  }, 15000);
});

// ── list_agents ──

describe("list_agents", () => {
  it("returns formatted table with spawned agents", async () => {
    await handlers.spawn_agent({ task: "research task", port: 5080, profile: "generic" });
    await handlers.spawn_agent({ task: "testing task", port: 5081, profile: "desktop" });

    const result = await handlers.list_agents();
    expect(result).toContain("5080");
    expect(result).toContain("5081");
    expect(result).toContain("research task");
    expect(result).toContain("testing task");
    expect(result).toContain("Port");
    expect(result).toContain("Status");
  });

  it("shows profile in agent listing", async () => {
    await handlers.spawn_agent({ task: "profile test", port: 5090, profile: "marketer" });
    const result = await handlers.list_agents();
    expect(result).toContain("marketer");
  });
});

// ── wait_tasks ──

describe("wait_tasks", () => {
  it("returns error when no tasks found for goal", async () => {
    const { getTaskStats } = await import("../../../src/tasks/queries.js");
    getTaskStats.mockReturnValue({ total: 0, pending: 0, in_progress: 0, done: 0, skipped: 0 });

    const result = await handlers.wait_tasks({ goal_id: 999 });
    expect(result).toContain("no tasks found");
  });

  it("returns immediately when all tasks are done", async () => {
    const { getTaskStats, getTasksByGoalAndStatus } = await import("../../../src/tasks/queries.js");
    getTaskStats.mockReturnValue({ total: 2, pending: 0, in_progress: 0, done: 2, skipped: 0 });
    getTasksByGoalAndStatus.mockReturnValue([
      { id: 1, title: "Task A", status: "done", result: "OK" },
      { id: 2, title: "Task B", status: "done", result: "OK" },
    ]);

    const result = await handlers.wait_tasks({ goal_id: 1 });
    expect(result).toContain("All 2 tasks completed");
    expect(result).toContain("Task A");
    expect(result).toContain("Task B");
  });

  it("returns immediately when all tasks done or skipped", async () => {
    const { getTaskStats, getTasksByGoalAndStatus } = await import("../../../src/tasks/queries.js");
    getTaskStats.mockReturnValue({ total: 2, pending: 0, in_progress: 0, done: 1, skipped: 1 });
    getTasksByGoalAndStatus.mockReturnValue([
      { id: 1, title: "Task A", status: "done", result: "OK" },
      { id: 2, title: "Task B", status: "skipped", result: "not needed" },
    ]);

    const result = await handlers.wait_tasks({ goal_id: 1 });
    expect(result).toContain("All 2 tasks completed");
    expect(result).toContain("Done: 1, Skipped: 1");
  });

  it("reports timeout with partial results", async () => {
    const { getTaskStats, getTasksByGoalAndStatus } = await import("../../../src/tasks/queries.js");
    getTaskStats.mockReturnValue({ total: 3, pending: 1, in_progress: 1, done: 1, skipped: 0 });
    getTasksByGoalAndStatus.mockReturnValue([
      { id: 2, title: "Still running", status: "in_progress" },
      { id: 3, title: "Waiting", status: "pending" },
    ]);

    const result = await handlers.wait_tasks({ goal_id: 1, timeout: 1 });
    expect(result).toContain("Timeout");
    expect(result).toContain("In progress: 1");
    expect(result).toContain("Pending: 1");
  });
});
