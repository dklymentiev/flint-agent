// A headless run with OPENROUTER_API_KEY in the environment must NOT persist
// the key to disk. The key is already available in the process environment;
// writing keys.enc/.seed/.salt is a side effect the caller did not ask for.
//
// This test reproduces the defect: migrateKeys() is called during startup
// (index.js:123) and calls setKey() which saves to disk via saveKeysFile().
// In headless mode this should be skipped.
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "flint-hd-keys-"));
const flintDir = path.join(tmpBase, ".flint");

afterAll(() => {
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

vi.mock("../../src/logging/logger.js", () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}));

// Mock config to use our temp directory for .flint
vi.mock("../../src/config.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    config: {
      ...actual.config,
      headless: false,
      projectRoot: tmpBase,
      sessionsDir: path.join(tmpBase, "sessions"),
      provider: "openrouter",
      model: "test-model",
      port: 3000,
    },
  };
});

// Mock the DPAPI/key derivation to use our temp dir
vi.mock("../../src/providers/keys-dpapi.js", () => ({
  protectData: (data) => "protected:" + data,
  unprotectData: (data) => data.replace("protected:", ""),
}));

vi.mock("../../src/providers/keys-fallback.js", () => ({
  deriveKey: () => Buffer.from("test-key-32-bytes-for-aes256-gcm", "utf-8"),
}));

// Mock os.homedir to point to our temp dir so keys.js writes there
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    homedir: () => tmpBase,
    tmpdir: () => os.tmpdir(),
    platform: () => process.platform,
  };
});

// Mock permissions to avoid file I/O
vi.mock("../../src/tools/permissions.js", () => ({
  initPermissions: () => {},
  setUnattended: () => {},
  bulkSetPermission: () => {},
  getOnboardingState: () => ({ asked: true }),
  askOnboardingIfNeeded: () => Promise.resolve(),
  resetPermissionState: () => {},
  resetSessionOverrides: () => {},
  getConfirmTimeoutMs: () => 600000,
}));

vi.mock("../../src/tools/registry.js", () => ({
  initRegistry: () => {},
  registerMcpTools: () => {},
  registerMeshTools: () => {},
  registerTaskTools: () => {},
  registerDatasetTools: () => {},
  registerScheduleTools: () => {},
  registerInboxTools: () => {},
  registerPlugin: () => {},
  setMcpManagement: () => {},
}));

vi.mock("../../src/plugins/loader.js", () => ({
  loadPlugins: () => Promise.resolve({ loaded: [], errors: [] }),
}));

vi.mock("../../src/mcp-client.js", () => ({
  connectMcpServers: () => Promise.resolve({ tools: [], handlers: {}, results: [] }),
  withUserMcpServers: (servers) => servers,
  parseServerConfig: (servers) => servers,
  mcpJsonServers: (servers) => servers,
  getServerStatus: () => [],
  disconnectServer: () => {},
  reconnectServer: () => {},
}));

vi.mock("../../src/security/index.js", () => ({
  initSecurity: () => ({ authMiddleware: null }),
}));

vi.mock("../../src/stdio/guard.js", () => ({
  stdioArgs: null,
  protocolWrite: () => {},
}));

vi.mock("../../src/production-env.js", () => ({
  restoreNodeEnv: () => {},
}));

vi.mock("../../src/store/index.js", () => {
  const listeners = new Set();
  return {
    store: {
      getState: () => ({
        sessionId: "test-session",
        messages: [],
        inputHistory: [],
        plan: null,
        addLine: () => {},
        setSession: () => {},
        setProfile: () => {},
        setModel: () => {},
        setProvider: () => {},
        pushInputHistory: () => {},
        subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
        _taskRegistry: [],
        currentTool: null,
        agentStatus: "idle",
        escAbort: () => null,
        abortAll: () => [],
        pendingConfirmation: null,
        queuedInputs: [],
        clearPendingConfirmation: () => {},
        setPendingConfirmation: () => {},
        takeQueuedInput: () => {},
      }),
      subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
      setState: (partial) => { Object.assign(store.getState(), partial); listeners.forEach(l => l(store.getState(), store.getState())); },
    },
  };
});

vi.mock("../../src/app-state.js", () => ({
  app: {
    activeProfile: "generic",
    profileConfig: { content: "", contextMode: "full" },
    hostPrompt: "",
    systemMessage: null,
    mcpStatusList: [],
    mcpReady: false,
    shuttingDown: false,
    abortController: null,
  },
  sessionData: () => ({}),
}));

vi.mock("../../src/sessions.js", () => ({
  generateSessionId: () => "test-session",
  saveSession: () => Promise.resolve(),
  loadSession: () => Promise.resolve({ messages: [], inputHistory: [] }),
  listSessions: () => Promise.resolve([]),
}));

vi.mock("../../src/bootstrap.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    bootstrap: () => Promise.resolve({
      log: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
      initialMessages: [],
      initialInputHistory: [],
      explicitProfile: "generic",
    }),
  };
});

vi.mock("../../src/api/server.js", () => ({
  startServer: () => ({ port: 3000, then: (fn) => fn({ port: 3000 }) }),
}));

vi.mock("../../src/stdio/run.js", () => ({
  runStdio: () => Promise.resolve(),
}));

vi.mock("../../src/ui/output.js", () => ({
  initOutput: () => {},
  printHeader: () => {},
  printSystem: () => {},
  printWarning: () => {},
  printConfirmResult: () => {},
}));

vi.mock("../../src/components/App.js", () => ({
  App: () => null,
}));

vi.mock("ink", () => ({
  render: () => ({ unmount: () => {} }),
  Text: ({ children }) => children,
}));

vi.mock("react", () => ({
  createElement: (type, props, ...children) => ({ type, props, children }),
}));

vi.mock("../../src/tools/own-env.js", () => ({
  ensureOwnEnv: () => {},
  getSandboxMode: () => "none",
}));

vi.mock("../../src/sandbox/backend.js", () => ({
  getSandboxMode: () => "none",
  cleanupSandbox: () => {},
}));

vi.mock("../../src/tasks/queries.js", () => ({
  syncPlanToStore: () => {},
  getActiveGoal: () => null,
  getTaskStats: () => ({ pending: 0, in_progress: 0, total: 0, done: 0 }),
  abandonGoal: () => {},
  getDueReminders: () => [],
  fireReminder: () => {},
  claimTask: () => {},
  getTaskById: () => null,
  completeTaskWithResult: () => {},
  gcStaleSessions: () => 0,
}));

vi.mock("../../src/tasks/db.js", () => ({
  closeDb: () => {},
}));

vi.mock("../../src/registry.js", () => ({
  registerAgent: () => {},
  unregisterAgent: () => {},
}));

vi.mock("../../src/logging/logger.js", () => ({
  initLogger: () => {},
  createLogger: () => ({ info: () => {}, debug: () => {}, warn: () => {}, error: () => {} }),
}));

vi.mock("../../src/logging/chat-log.js", () => ({
  logChatLine: () => {},
}));

vi.mock("../../src/logging/chat-log-follower.js", () => ({
  createChatLogFollower: () => ({ start: () => ({ skipped: 0 }) }),
}));

vi.mock("../../src/agent/usage.js", () => ({
  setPricingSource: () => {},
  seedSessionSpend: () => {},
}));

vi.mock("../../src/agent/system-prompt.js", () => ({
  getSystemMessage: () => ({ role: "system", content: "test" }),
  prefetchAgentMemory: () => Promise.resolve(),
}));

vi.mock("../../src/api/client.js", () => ({
  fetchModelInfo: () => Promise.resolve(null),
  setFreeNoticeSink: () => {},
}));

vi.mock("../../src/tools/system.js", () => ({
  killAllChildren: () => {},
}));

vi.mock("../../src/memory/inbox.js", () => ({
  pushInbox: () => {},
}));

vi.mock("../../src/startup-watchdog.js", () => ({
  startStartupWatchdog: () => {},
  clearStartupWatchdog: () => {},
  whileWaitingForOperator: (fn) => fn(),
}));

vi.mock("../../src/input-handler.js", () => ({
  withLock: (fn) => fn(),
}));

vi.mock("../../src/bus/index.js", () => ({
  push: () => ({ id: "test" }),
  flush: () => {},
  waitForResult: () => Promise.resolve({}),
  isProcessing: () => false,
  PRIORITY: { USER: 1, API: 2, TASK: 3 },
  stats: () => ({ pending: 0 }),
  prepareQueueAtStart: () => ({ recovered: 0, expired: 0 }),
}));

vi.mock("../../src/bus/plugins.js", () => ({
  loadPlugins: () => {},
  stopPlugins: () => {},
}));

vi.mock("../../src/commands/registry.js", () => ({
  initCommands: () => {},
  tryHandleCommand: () => false,
  isSlashCommand: () => false,
}));

vi.mock("../../src/agent/supervisor.js", () => ({
  setSupervisorEnabled: () => {},
}));

vi.mock("../../src/agent/auto.js", () => ({
  runAutoMode: () => Promise.resolve(),
}));

vi.mock("../../src/restart.js", () => ({
  carriedBulkPermission: () => null,
}));

vi.mock("../../src/update.js", () => ({
  checkForUpdate: () => Promise.resolve(null),
  installKind: () => "unknown",
  updateNotice: () => null,
}));

vi.mock("../../src/child-idle.js", () => ({
  childBusy: () => false,
}));

describe("--headless: does not persist API key from env to disk", () => {
  let originalEnv;

  beforeEach(() => {
    vi.resetModules();
    originalEnv = { ...process.env };
    // Clean temp dir
    if (fs.existsSync(flintDir)) fs.rmSync(flintDir, { recursive: true, force: true });
    process.env.OPENROUTER_API_KEY = "sk-test-key-from-environment-1234567890";
    process.env.FLINT_TEST_PERMISSIONS_FILE = path.join(tmpBase, ".permissions.json");
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("does not create keys.enc when OPENROUTER_API_KEY is in env and headless=true", async () => {
    const { config } = await import("../../src/config.js");
    config.headless = true;
    
    const { migrateKeys } = await import("../../src/cli.js");
    await migrateKeys();
    
    // keys.enc should NOT exist
    const keysFile = path.join(flintDir, "keys.enc");
    expect(fs.existsSync(keysFile), "keys.enc was created in headless mode").toBe(false);
    
    // .seed.dpapi or .seed should NOT exist
    const seedFile = path.join(flintDir, ".seed.dpapi");
    const seedFallback = path.join(flintDir, ".seed");
    expect(fs.existsSync(seedFile), ".seed.dpapi was created in headless mode").toBe(false);
    expect(fs.existsSync(seedFallback), ".seed was created in headless mode").toBe(false);
  });

  it("creates keys.enc when headless=false (interactive) to document current behavior", async () => {
    const { config } = await import("../../src/config.js");
    config.headless = false;
    
    const { migrateKeys } = await import("../../src/cli.js");
    await migrateKeys();
    
    // keys.enc SHOULD exist in interactive mode (current behavior)
    const keysFile = path.join(flintDir, "keys.enc");
    expect(fs.existsSync(keysFile), "keys.enc was NOT created in interactive mode (current behavior)").toBe(true);
  });
});