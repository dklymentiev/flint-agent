// Integration tests for agent spawn configuration (Phase R7)
// Verifies spawn command construction without actually spawning processes

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createMockStore } from "../helpers/mock-store.js";
import { activeChildren } from "../../src/tools/process-tools.js";
import { EventEmitter } from "node:events";

// Mock UI output
vi.mock("../../src/ui/output.js", () => ({
  printChildAgent: vi.fn(),
  printChildSpawn: vi.fn(),
  printChildEvent: vi.fn(),
  printProcessStart: vi.fn(),
  printProcessEnd: vi.fn(),
  printProcessSummary: vi.fn(),
  setProcessStream: vi.fn(),
}));

// Mock filesystem
vi.mock("../../src/tools/filesystem.js", () => ({
  getDeniedPaths: vi.fn(() => []),
}));

// Mock task queries
vi.mock("../../src/tasks/queries.js", () => ({
  getTask: vi.fn(),
  getTasksByGoalAndStatus: vi.fn(() => []),
  getTaskStats: vi.fn(),
}));

// Capture spawn calls
const mockSpawn = vi.fn();
vi.mock("node:child_process", () => ({
  spawn: (...args) => mockSpawn(...args),
}));

vi.mock("../../src/config.js", () => ({
  config: {
    maxChildAgents: 50,
    childIdleTimeout: 60,
    childCleanupDelay: 100,
    projectRoot: "/opt/flint",
    port: 3000,
    provider: "openrouter",
    apiKey: "or-test-key-xxx",
  },
}));

let store;
let handlers;
let _fakeChildren = [];

function createFakeChild() {
  const child = new EventEmitter();
  child.pid = 55555;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  child.unref = vi.fn();
  _fakeChildren.push(child);
  return child;
}

// Helper to extract spawn options (env, cwd) from the last mockSpawn call.
// On Windows: spawn("cmd.exe", ["/c", cmd], opts)
// On Unix: spawn("/bin/bash", ["-c", cmd], opts)
// Both use index [2] for options.
function getLastSpawnOpts() {
  const calls = mockSpawn.mock.calls;
  return calls[calls.length - 1][2];
}

// Extract the command string from last spawn call
function getLastSpawnCmd() {
  const calls = mockSpawn.mock.calls;
  const args = calls[calls.length - 1][1];
  return args[args.length - 1]; // last arg is always the command string
}

beforeEach(async () => {
  store = createMockStore();
  activeChildren.clear();
  mockSpawn.mockReset();
  _fakeChildren = [];
  mockSpawn.mockImplementation(() => createFakeChild());

  const mod = await import("../../src/tools/agent-tools.js");
  handlers = mod.createAgentHandlers(store);
});

afterEach(() => {
  activeChildren.clear();
  for (const child of _fakeChildren) {
    child.emit("close", 0);
  }
});

describe("spawn command construction", () => {
  it("includes --port with assigned port", async () => {
    await handlers.spawn_agent({ task: "test port flag", port: 3015 });
    const cmdStr = getLastSpawnCmd();
    expect(cmdStr).toContain("--port 3015");
  });

  it("includes --profile with specified profile", async () => {
    await handlers.spawn_agent({ task: "test profile", port: 8010, profile: "marketer" });
    const cmdStr = getLastSpawnCmd();
    expect(cmdStr).toContain("--profile marketer");
  });

  it("includes --new flag for fresh session", async () => {
    await handlers.spawn_agent({ task: "test new flag", port: 8020 });
    const cmdStr = getLastSpawnCmd();
    expect(cmdStr).toContain("--new");
  });

  it("includes --model when model is specified", async () => {
    await handlers.spawn_agent({ task: "test model", port: 8030, model: "claude-3-opus" });
    const cmdStr = getLastSpawnCmd();
    expect(cmdStr).toContain("--model claude-3-opus");
  });

  it("sets AGENT_TASK_ID in env when task_id provided", async () => {
    await handlers.spawn_agent({ task: "task-driven", task_id: 77, port: 8040 });
    const opts = getLastSpawnOpts();
    expect(opts.env.AGENT_TASK_ID).toBe("77");
  });

  it("does not include AGENT_TASK_ID when task_id not provided", async () => {
    await handlers.spawn_agent({ task: "no task id", port: 8050 });
    const opts = getLastSpawnOpts();
    expect(opts.env.AGENT_TASK_ID).toBeUndefined();
  });

  it("filters sensitive API keys from child env", async () => {
    const origOpenai = process.env.OPENAI_API_KEY;
    const origAnthropic = process.env.ANTHROPIC_API_KEY;
    const origOpenrouter = process.env.OPENROUTER_API_KEY;
    process.env.OPENAI_API_KEY = "sk-openai-secret";
    process.env.ANTHROPIC_API_KEY = "sk-ant-secret";
    process.env.OPENROUTER_API_KEY = "sk-or-secret";

    try {
      await handlers.spawn_agent({ task: "env filter", port: 8060 });
      const env = getLastSpawnOpts().env;
      // Active provider key (openrouter) set from config.apiKey
      expect(env.OPENROUTER_API_KEY).toBe("or-test-key-xxx");
      // Other keys must be removed
      expect(env.OPENAI_API_KEY).toBeUndefined();
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    } finally {
      if (origOpenai !== undefined) process.env.OPENAI_API_KEY = origOpenai; else delete process.env.OPENAI_API_KEY;
      if (origAnthropic !== undefined) process.env.ANTHROPIC_API_KEY = origAnthropic; else delete process.env.ANTHROPIC_API_KEY;
      if (origOpenrouter !== undefined) process.env.OPENROUTER_API_KEY = origOpenrouter; else delete process.env.OPENROUTER_API_KEY;
    }
  });

  it("sets AGENT_PARENT_PORT to parent's port", async () => {
    await handlers.spawn_agent({ task: "parent port", port: 8070 });
    const env = getLastSpawnOpts().env;
    expect(env.AGENT_PARENT_PORT).toBe("3000");
  });

  it("increments AGENT_DEPTH for child", async () => {
    const origDepth = process.env.AGENT_DEPTH;
    process.env.AGENT_DEPTH = "1";
    try {
      await handlers.spawn_agent({ task: "depth test", port: 8080 });
      const env = getLastSpawnOpts().env;
      expect(env.AGENT_DEPTH).toBe("2");
    } finally {
      if (origDepth !== undefined) process.env.AGENT_DEPTH = origDepth; else delete process.env.AGENT_DEPTH;
    }
  });

  it("sets AGENT_IDLE_TIMEOUT from config", async () => {
    await handlers.spawn_agent({ task: "idle timeout", port: 8090 });
    const env = getLastSpawnOpts().env;
    expect(env.AGENT_IDLE_TIMEOUT).toBe("60");
  });

  it("sets FLINT_PROVIDER in child env", async () => {
    await handlers.spawn_agent({ task: "provider propagation", port: 8100 });
    const env = getLastSpawnOpts().env;
    expect(env.FLINT_PROVIDER).toBe("openrouter");
  });

  it("sets cwd to projectRoot", async () => {
    await handlers.spawn_agent({ task: "cwd test", port: 8110 });
    const opts = getLastSpawnOpts();
    expect(opts.cwd).toBe("/opt/flint");
  });
});
