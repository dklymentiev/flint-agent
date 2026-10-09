// Test: children of headless parents must NOT get AGENT_PARENT_PORT.
//
// When a headless parent spawns a child agent, the parent has no HTTP server
// (startServer is skipped in headless mode). If the child still receives
// AGENT_PARENT_PORT and AGENT_PAIRING_SECRET, its orphan-protection heartbeat
// polls a dead port and kills the child after ~60s.
//
// Fix: agent-tools.js should only set those env vars when config.headless is
// false (parent has a server). This test is red without that fix.

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { createAgentHandlers } from "../../src/tools/agent-tools.js";
import { config } from "../../src/config.js";

let capturedEnv = null;

vi.mock("node:child_process", () => ({
  spawn: vi.fn((...args) => {
    // The 3rd argument is the options object containing `env`
    if (args[2]?.env) capturedEnv = args[2].env;
    return {
      pid: 99999,
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn(),
      send: vi.fn(),
      kill: vi.fn(),
      stdio: ["ignore", "pipe", "pipe"],
    };
  }),
}));

vi.mock("../../src/logging/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock("./process-tools.js", () => ({
  activeChildren: { on: vi.fn(), emit: vi.fn() },
}));

vi.mock("../../src/tasks/queries.js", () => ({
  getTask: vi.fn(),
  getTasksByGoalAndStatus: vi.fn(),
  getTaskStats: vi.fn(),
}));

vi.mock("../../src/api/address.js", () => ({
  apiUrl: vi.fn((port, p) => `http://127.0.0.1:${port}${p}`),
}));

vi.mock("../../src/ui/output.js", () => ({
  printChildAgent: vi.fn(),
  printChildSpawn: vi.fn(),
  printChildEvent: vi.fn(),
  addLine: vi.fn(),
}));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    default: { ...actual, homedir: () => "/tmp/fake-home", platform: () => "linux" },
    homedir: () => "/tmp/fake-home",
    platform: () => "linux",
  };
});

// Stub filesystem getDeniedPaths (loaded dynamically inside spawn_agent)
vi.mock("../../src/tools/filesystem.js", () => ({
  getDeniedPaths: () => [],
  getAllowedPaths: () => [],
}));

function makeStore() {
  const state = {
    addProcess: vi.fn(() => 1),
    registerTask: vi.fn(() => 1),
    unregisterTask: vi.fn(),
    setAgentStatus: vi.fn(),
    getChildAgents: () => ({}),
    updateChild: vi.fn(),
  };
  return {
    getState: () => state,
    setState: () => {},
  };
}

describe("headless child agent env", () => {
  beforeEach(() => {
    capturedEnv = null;
    config.headless = false;
    config.port = 3000;
  });

  afterEach(() => {
    config.headless = false;
  });

  it("does NOT set AGENT_PARENT_PORT when parent is headless", async () => {
    config.headless = true;
    const store = makeStore();
    const handlers = createAgentHandlers(store);

    await handlers.spawn_agent({ task: "test headless child" });

    expect(capturedEnv).not.toBeNull();
    // AGENT_PARENT_PORT must be absent so the child's orphan-protection
    // heartbeat doesn't start (parent has no HTTP server in headless mode).
    expect(capturedEnv.AGENT_PARENT_PORT).toBeUndefined();
    // AGENT_PAIRING_SECRET must still be present for parent↔child API auth.
    expect(capturedEnv.AGENT_PAIRING_SECRET).toBeDefined();
  });

  it("DOES set AGENT_PARENT_PORT when parent is NOT headless", async () => {
    config.headless = false;
    const store = makeStore();
    const handlers = createAgentHandlers(store);

    await handlers.spawn_agent({ task: "test interactive child" });

    expect(capturedEnv).not.toBeNull();
    expect(capturedEnv.AGENT_PARENT_PORT).toBeDefined();
    expect(capturedEnv.AGENT_PAIRING_SECRET).toBeDefined();
  });
});
