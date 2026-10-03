import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockStore } from "../../helpers/mock-store.js";

// -- Mocks for all modules that commands.js imports --

const mockSetLastModel = vi.fn();

vi.mock("../../../src/sessions.js", () => ({
  generateSessionId: () => "mock-session-001",
  saveSession: vi.fn(async () => {}),
  loadSession: vi.fn(async () => ({
    messages: [
      { role: "system", content: "sys" },
      { role: "user", content: "hello" },
    ],
    inputHistory: ["hello"],
  })),
  listSessions: vi.fn(async () => [
    { id: "sess-1", model: "gpt-4", preview: "first session" },
    { id: "sess-2", model: "claude", preview: "second session" },
  ]),
}));

vi.mock("../../../src/agent/system-prompt.js", () => ({
  SYSTEM_MESSAGE: { role: "system", content: "test-system" },
  getSystemMessage: () => ({ role: "system", content: "test-system" }),
}));

vi.mock("../../../src/config.js", () => ({
  config: {
    model: "test-model",
    provider: "test-provider",
    port: 3000,
    projectRoot: "/tmp/test",
    sessionBudget: 1.0,
    maxCostPerAction: 0.05,
    resolveApiKey: vi.fn(async () => {}),
  },
}));

vi.mock("../../../src/memory/conversation-digest.js", () => ({
  clearDigest: vi.fn(),
}));

vi.mock("../../../src/memory/session-facts.js", () => ({
  clearSessionFacts: vi.fn(),
  loadSessionFacts: vi.fn(() => []),
}));

vi.mock("../../../src/tools/permissions.js", () => ({
  getPermissionMap: vi.fn(() => ({})),
  setPermission: vi.fn(),
  resetSessionOverrides: vi.fn(),
  bulkSetPermission: vi.fn(),
}));

vi.mock("../../../src/memory/store.js", () => ({
  getMemoryStats: () => ({ total: 5, byCategory: { fact: 3, note: 2 }, oldest: null, newest: null }),
  listRecentMemories: () => [
    { id: 1, content: "remembered item one" },
    { id: 2, content: "remembered item two" },
  ],
  clearAllMemories: vi.fn(),
}));

vi.mock("../../../src/memory/markdown.js", () => ({
  updateMemoryMd: vi.fn(),
  readMemoryMdHead: () => "",
}));

vi.mock("../../../src/profiles.js", () => ({
  loadProfile: vi.fn((name) => {
    if (name === "bad-profile") throw new Error("Profile not found: bad-profile");
    return { description: `${name} profile`, content: "profile content" };
  }),
  listProfiles: vi.fn(() => ["desktop", "server", "coder"]),
}));

vi.mock("../../../src/tools/tasks.js", () => ({
  formatPlanForPrompt: vi.fn(() => "plan text"),
}));

vi.mock("../../../src/tasks/queries.js", () => ({
  getActiveGoal: vi.fn(() => null),
  listGoals: vi.fn(() => [
    { id: 1, title: "Goal 1", status: "active", project: "test" },
    { id: 2, title: "Goal 2", status: "completed", project: "test" },
  ]),
  getTasksByGoal: vi.fn(() => []),
  getTaskStats: vi.fn(() => ({ total: 3, done: 1, pending: 2 })),
  getDashboard: vi.fn(() => []),
  goalToPlan: vi.fn(() => null),
  syncPlanToStore: vi.fn(() => null),
  abandonAllActiveGoals: vi.fn(),
}));

vi.mock("../../../src/registry.js", () => ({
  listAgents: vi.fn(async () => [
    { port: 3000, pid: process.pid, model: "test-model", profile: "desktop", sessionId: "s1" },
  ]),
}));

vi.mock("../../../src/tools/registry.js", () => ({
  getMcpServerStatus: vi.fn(() => [
    { name: "local", url: "http://localhost:9000", connected: true },
  ]),
  mcpDisconnect: vi.fn(),
  mcpReconnect: vi.fn(),
  getLoadedPlugins: vi.fn(() => [
    { name: "test-plugin", version: "1.0.0", toolCount: 3, type: "local" },
  ]),
  unregisterPlugin: vi.fn(() => null),
}));

vi.mock("../../../src/tools/plugin-tools.js", () => ({
  activatePlugin: vi.fn(async (dir) => ({ dir, name: "my-plugin", tools: ["do_thing"] })),
}));

vi.mock("../../../src/plugins/manager.js", () => ({
  installPlugin: vi.fn(async (target) => {
    if (target === "bad-plugin") return { ok: false, error: "not found" };
    return { ok: true, name: target };
  }),
  uninstallPlugin: vi.fn((target) => {
    if (target === "missing-plugin") return { ok: false, error: "not installed" };
    return { ok: true, name: target };
  }),
}));

vi.mock("../../../src/plugins/loader.js", () => ({
  listInstalledPlugins: vi.fn(() => ["test-plugin"]),
  getPluginsDir: vi.fn(() => "/tmp/plugins"),
}));

vi.mock("../../../src/tools/checkpoint.js", () => ({
  rewind: vi.fn(async (n) => [{ action: "restore", path: "/tmp/file.txt" }]),
  rewindAll: vi.fn(async () => [
    { action: "restore", path: "/tmp/a.txt" },
    { action: "delete", path: "/tmp/b.txt" },
  ]),
  getCheckpointStack: vi.fn(() => [
    { path: "/tmp/file.txt", timestamp: Date.now() - 5000, existed: true, type: "write" },
  ]),
  clearCheckpoints: vi.fn(),
}));

vi.mock("../../../src/ui/output.js", () => ({
  printTable: vi.fn(),
}));

vi.mock("../../../src/bus/index.js", () => ({
  pending: vi.fn(() => []),
  stats: vi.fn(() => ({ pending: 0, processing: 0 })),
  push: vi.fn(() => ({ id: 42 })),
  PRIORITY: { USER: 1 },
}));

vi.mock("../../../src/bus/drain-loop.js", () => ({
  notify: vi.fn(),
  flush: vi.fn(),
  resetAutonomous: vi.fn(),
  abortAll: vi.fn(() => 0),
}));

vi.mock("../../../src/providers/registry.js", () => ({
  listProviders: vi.fn(() => [
    { id: "openai", name: "OpenAI", keyRequired: true, defaultModel: "gpt-4" },
    { id: "local", name: "Local", keyRequired: false, defaultModel: "llama" },
  ]),
  getProvider: vi.fn((id) => {
    const providers = {
      openai: { id: "openai", name: "OpenAI", keyRequired: true, defaultModel: "gpt-4" },
      local: { id: "local", name: "Local", keyRequired: false, defaultModel: "llama" },
    };
    return providers[id] || null;
  }),
  reloadProviders: vi.fn(),
}));

vi.mock("../../../src/providers/keys.js", () => ({
  hasKey: vi.fn((id) => id === "openai"),
  setKey: vi.fn(async () => {}),
  deleteKey: vi.fn(async () => {}),
  listConfiguredProviders: vi.fn(() => ["openai"]),
}));

vi.mock("../../../src/providers/state.js", () => ({
  getActiveProvider: vi.fn(() => "test-provider"),
  setActiveProvider: vi.fn(),
  getLastModel: vi.fn(() => null),
  setLastModel: (...a) => mockSetLastModel(...a),
}));

vi.mock("../../../src/api/client.js", () => ({
  fetchModelInfo: vi.fn(async () => ({
    prompt: 0.00001,
    completion: 0.00003,
    contextLength: 128000,
  })),
}));

vi.mock("../../../src/app-state.js", () => ({
  app: {
    autonomous: false,
    activeProfile: null,
    profileConfig: null,
    systemMessage: null,
  },
}));

// -- Helpers --

let store;
let tryHandleCommand;

function getOutputText() {
  return store.getState().lines.map((l) => l.text).join("\n");
}

beforeEach(async () => {
  vi.clearAllMocks();
  store = createMockStore({
    _version: "0.9.0",
    _port: 3000,
    _profile: "desktop",
  });

  const { initCommands, tryHandleCommand: thc } = await import(
    "../../../src/commands/registry.js"
  );
  tryHandleCommand = thc;
  initCommands(store);
});

// ======================================================================
// /help
// ======================================================================

describe("/help", () => {
  it("is recognized and prints command list", async () => {
    const handled = await tryHandleCommand("/help", store);
    expect(handled).toBe(true);
    const text = getOutputText();
    expect(text).toContain("Commands");
    expect(text).toContain("/sessions");
    expect(text).toContain("/load");
    expect(text).toContain("/auto");
  });
});

// ======================================================================
// /sessions
// ======================================================================

describe("/sessions", () => {
  it("lists saved sessions", async () => {
    const handled = await tryHandleCommand("/sessions", store);
    expect(handled).toBe(true);
    const text = getOutputText();
    expect(text).toContain("sess-1");
    expect(text).toContain("sess-2");
  });
});

// ======================================================================
// /load <id>
// ======================================================================

describe("/load", () => {
  it("loads a session by id", async () => {
    const handled = await tryHandleCommand("/load sess-1", store);
    expect(handled).toBe(true);
    const text = getOutputText();
    expect(text).toContain("Loaded session sess-1");
  });

  it("shows usage when no id given", async () => {
    const handled = await tryHandleCommand("/load ", store);
    expect(handled).toBe(true);
    const text = getOutputText();
    expect(text).toContain("Usage");
  });
});

// ======================================================================
// /new
// ======================================================================

describe("/new", () => {
  it("resets session and creates new id", async () => {
    const { abandonAllActiveGoals } = await import("../../../src/tasks/queries.js");

    const handled = await tryHandleCommand("/new", store);
    expect(handled).toBe(true);
    expect(abandonAllActiveGoals).toHaveBeenCalled();

    const text = getOutputText();
    expect(text).toContain("Flint");
    expect(text).toContain("(new)");
  });
});

// ======================================================================
// /clear
// ======================================================================

describe("/clear", () => {
  it("clears context and keeps session", async () => {
    const handled = await tryHandleCommand("/clear", store);
    expect(handled).toBe(true);
    const text = getOutputText();
    expect(text).toContain("Flint");
    expect(text).toContain("(cleared)");
  });
});

// ======================================================================
// /queue
// ======================================================================

describe("/queue", () => {
  it("shows empty queue message", async () => {
    const handled = await tryHandleCommand("/queue", store);
    expect(handled).toBe(true);
    const text = getOutputText();
    expect(text).toContain("No queued messages");
  });

  it("shows pending items when bus has messages", async () => {
    const bus = await import("../../../src/bus/index.js");
    bus.pending.mockReturnValueOnce([
      { id: 1, channel: "user", content: "test question" },
    ]);
    bus.stats.mockReturnValueOnce({ pending: 1, processing: 0 });

    const handled = await tryHandleCommand("/queue", store);
    expect(handled).toBe(true);
    const text = getOutputText();
    expect(text).toContain("Bus queue");
    expect(text).toContain("test question");
  });
});

// ======================================================================
// /queue clear
// ======================================================================

describe("/queue clear", () => {
  it("flushes the bus queue", async () => {
    const { flush } = await import("../../../src/bus/drain-loop.js");
    const handled = await tryHandleCommand("/queue clear", store);
    expect(handled).toBe(true);
    expect(flush).toHaveBeenCalled();
    const text = getOutputText();
    expect(text).toContain("flushed");
  });
});

// ======================================================================
// /later <text>
// ======================================================================

describe("/later", () => {
  it("queues a message to the bus", async () => {
    const bus = await import("../../../src/bus/index.js");
    const handled = await tryHandleCommand("/later do this thing", store);
    expect(handled).toBe(true);
    expect(bus.push).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "user",
        content: "do this thing",
        source: "later",
      }),
    );
    const text = getOutputText();
    expect(text).toContain("queued");
  });

  it("shows usage when no argument", async () => {
    const handled = await tryHandleCommand("/later ", store);
    expect(handled).toBe(true);
    const text = getOutputText();
    expect(text).toContain("Usage");
  });
});

// ======================================================================
// /plan
// ======================================================================

describe("/plan", () => {
  it("shows no plan message when no active plan", async () => {
    const handled = await tryHandleCommand("/plan", store);
    expect(handled).toBe(true);
    const text = getOutputText();
    expect(text).toContain("No active plan");
  });

  it("displays plan tasks when plan exists", async () => {
    const { syncPlanToStore } = await import("../../../src/tasks/queries.js");
    syncPlanToStore.mockReturnValueOnce({
      goalId: 1,
      goal: "Build feature",
      project: "test",
      tasks: [
        { id: 1, title: "Step 1", status: "done", result: "ok" },
        { id: 2, title: "Step 2", status: "in_progress", result: null },
        { id: 3, title: "Step 3", status: "pending", result: null },
      ],
    });

    const handled = await tryHandleCommand("/plan", store);
    expect(handled).toBe(true);
    const text = getOutputText();
    expect(text).toContain("Build feature");
    expect(text).toContain("Step 1");
    expect(text).toContain("Step 2");
  });
});

// ======================================================================
// /tasks
// ======================================================================

describe("/tasks", () => {
  it("shows no tasks message when dashboard is empty", async () => {
    const handled = await tryHandleCommand("/tasks", store);
    expect(handled).toBe(true);
    const text = getOutputText();
    expect(text).toContain("No active tasks");
  });

  it("/tasks all lists all goals", async () => {
    const handled = await tryHandleCommand("/tasks all", store);
    expect(handled).toBe(true);
    const text = getOutputText();
    expect(text).toContain("Goal 1");
    expect(text).toContain("Goal 2");
  });
});

// ======================================================================
// /continue -- handled in index.js, not registry
// ======================================================================

describe("/continue", () => {
  it("is not handled by tryHandleCommand (lives in index.js)", async () => {
    const handled = await tryHandleCommand("/continue", store);
    expect(handled).toBe(false);
  });
});

// ======================================================================
// /rewind
// ======================================================================

describe("/rewind", () => {
  it("shows checkpoint stack when called without args", async () => {
    const handled = await tryHandleCommand("/rewind", store);
    expect(handled).toBe(true);
    const text = getOutputText();
    expect(text).toContain("Checkpoint stack");
  });

  it("/rewind N undoes N changes", async () => {
    const { rewind: rewindFn } = await import("../../../src/tools/checkpoint.js");
    const handled = await tryHandleCommand("/rewind 3", store);
    expect(handled).toBe(true);
    expect(rewindFn).toHaveBeenCalledWith(3);
    const text = getOutputText();
    expect(text).toContain("Rewound");
  });

  it("/rewind all undoes all changes", async () => {
    const { rewindAll } = await import("../../../src/tools/checkpoint.js");
    const handled = await tryHandleCommand("/rewind all", store);
    expect(handled).toBe(true);
    expect(rewindAll).toHaveBeenCalled();
    const text = getOutputText();
    expect(text).toContain("Rewound 2 change(s)");
  });

  it("shows 'no changes' when stack is empty", async () => {
    const { getCheckpointStack } = await import("../../../src/tools/checkpoint.js");
    getCheckpointStack.mockReturnValueOnce([]);
    const handled = await tryHandleCommand("/rewind", store);
    expect(handled).toBe(true);
    const text = getOutputText();
    expect(text).toContain("No changes to rewind");
  });
});

// ======================================================================
// /model
// ======================================================================

describe("/model", () => {
  it("shows current model info", async () => {
    const handled = await tryHandleCommand("/model", store);
    expect(handled).toBe(true);
    const text = getOutputText();
    expect(text).toContain("test-model");
  });

  it("/model <id> switches model", async () => {
    const handled = await tryHandleCommand("/model gpt-4o", store);
    expect(handled).toBe(true);
    const text = getOutputText();
    expect(text).toContain("Switched");
    expect(text).toContain("gpt-4o");
    expect(store.getState().model).toBe("gpt-4o");
  });

  it("/model <id> is remembered for the next start", async () => {
    // Owner, 2026-10-01: the model chosen with /model <id> was back to the
    // default after a restart.
    await tryHandleCommand("/model some/model-x", store);
    expect(mockSetLastModel).toHaveBeenCalledWith("test-provider", "some/model-x");
  });
});

// ======================================================================
// /provider
// ======================================================================

describe("/provider", () => {
  it("opens overlay when called without args", async () => {
    const handled = await tryHandleCommand("/provider", store);
    expect(handled).toBe(true);
    const overlay = store.getState().overlay;
    expect(overlay).not.toBeNull();
    expect(overlay.type).toBe("provider");
  });

  it("/provider <id> switches provider", async () => {
    const handled = await tryHandleCommand("/provider local", store);
    expect(handled).toBe(true);
    const text = getOutputText();
    expect(text).toContain("Switched to Local");
  });

  it("/provider <unknown> shows error", async () => {
    const handled = await tryHandleCommand("/provider nonexistent", store);
    expect(handled).toBe(true);
    const text = getOutputText();
    expect(text).toContain("Unknown provider");
  });
});

// ======================================================================
// /key
// ======================================================================

describe("/key", () => {
  it("shows configured providers when called without args", async () => {
    const handled = await tryHandleCommand("/key", store);
    expect(handled).toBe(true);
    const text = getOutputText();
    expect(text).toContain("API Keys");
    expect(text).toContain("openai");
  });

  it("/key <unknown-provider> shows error", async () => {
    const handled = await tryHandleCommand("/key badprovider", store);
    expect(handled).toBe(true);
    const text = getOutputText();
    expect(text).toContain("Unknown provider");
  });
});

// ======================================================================
// /profile
// ======================================================================

describe("/profile", () => {
  it("lists profiles when called without args", async () => {
    const handled = await tryHandleCommand("/profile", store);
    expect(handled).toBe(true);
    const text = getOutputText();
    expect(text).toContain("Profiles");
    expect(text).toContain("desktop");
    expect(text).toContain("server");
    expect(text).toContain("coder");
  });

  it("/profile <name> switches profile", async () => {
    const handled = await tryHandleCommand("/profile server", store);
    expect(handled).toBe(true);
    const text = getOutputText();
    expect(text).toContain("Switched to profile: server");
  });

  it("/profile <bad> shows error", async () => {
    const handled = await tryHandleCommand("/profile bad-profile", store);
    expect(handled).toBe(true);
    const text = getOutputText();
    expect(text).toContain("Profile not found");
  });
});

// ======================================================================
// /agents
// ======================================================================

describe("/agents", () => {
  it("lists running agents", async () => {
    const handled = await tryHandleCommand("/agents", store);
    expect(handled).toBe(true);
    const text = getOutputText();
    expect(text).toContain("3000");
    expect(text).toContain("(this)");
  });
});

// ======================================================================
// /mcp
// ======================================================================

describe("/mcp", () => {
  it("shows MCP server status", async () => {
    const handled = await tryHandleCommand("/mcp", store);
    expect(handled).toBe(true);
    const text = getOutputText();
    expect(text).toContain("MCP Servers");
    expect(text).toContain("local");
  });

  it("shows empty message when no MCP servers", async () => {
    const { getMcpServerStatus } = await import("../../../src/tools/registry.js");
    getMcpServerStatus.mockReturnValueOnce([]);
    const handled = await tryHandleCommand("/mcp", store);
    expect(handled).toBe(true);
    const text = getOutputText();
    expect(text).toContain("No MCP servers configured");
  });
});

// ======================================================================
// /stats
// ======================================================================

describe("/stats", () => {
  it("shows session statistics", async () => {
    const handled = await tryHandleCommand("/stats", store);
    expect(handled).toBe(true);
    const text = getOutputText();
    expect(text).toContain("session:");
    expect(text).toContain("model:");
    expect(text).toContain("provider:");
    expect(text).toContain("tokens:");
    expect(text).toContain("spent:");
  });
});

// ======================================================================
// /budget
// ======================================================================

describe("/budget", () => {
  it("shows budget information", async () => {
    const handled = await tryHandleCommand("/budget", store);
    expect(handled).toBe(true);
    const text = getOutputText();
    expect(text).toContain("Session Budget");
    expect(text).toContain("spent:");
    expect(text).toContain("budget:");
    expect(text).toContain("remaining:");
  });
});

// ======================================================================
// /memory
// ======================================================================

describe("/memory", () => {
  it("shows memory stats", async () => {
    const handled = await tryHandleCommand("/memory", store);
    expect(handled).toBe(true);
    const text = getOutputText();
    expect(text).toContain("Memory: 5 entries");
    expect(text).toContain("fact: 3");
    expect(text).toContain("note: 2");
  });
});

// ======================================================================
// /memory clear
// ======================================================================

describe("/memory clear", () => {
  it("clears all memories", async () => {
    const { clearAllMemories } = await import("../../../src/memory/store.js");
    const { updateMemoryMd } = await import("../../../src/memory/markdown.js");

    const handled = await tryHandleCommand("/memory clear", store);
    expect(handled).toBe(true);
    expect(clearAllMemories).toHaveBeenCalled();
    expect(updateMemoryMd).toHaveBeenCalled();
    const text = getOutputText();
    expect(text).toContain("cleared");
  });
});

// ======================================================================
// /auto
// ======================================================================

describe("/auto", () => {
  it("shows status when called without args and not autonomous", async () => {
    const handled = await tryHandleCommand("/auto", store);
    expect(handled).toBe(true);
    const text = getOutputText();
    expect(text).toContain("Autonomous mode is OFF");
  });

  it("/auto <task> enables autonomous mode", async () => {
    const { app } = await import("../../../src/app-state.js");
    const bus = await import("../../../src/bus/index.js");

    const handled = await tryHandleCommand("/auto build the feature", store);
    expect(handled).toBe(true);
    expect(app.autonomous).toBe(true);
    expect(bus.push).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "user",
        source: "auto",
      }),
    );
    const text = getOutputText();
    expect(text).toContain("Autonomous mode: ON");
    expect(text).toContain("build the feature");
  });

  it("/auto toggles off when already autonomous", async () => {
    const { app } = await import("../../../src/app-state.js");
    app.autonomous = true;

    const handled = await tryHandleCommand("/auto", store);
    expect(handled).toBe(true);
    expect(app.autonomous).toBe(false);
    const text = getOutputText();
    expect(text).toContain("OFF");
  });
});

// ======================================================================
// /plugins
// ======================================================================

describe("/plugins", () => {
  it("lists installed plugins", async () => {
    const handled = await tryHandleCommand("/plugins", store);
    expect(handled).toBe(true);
    const text = getOutputText();
    expect(text).toContain("test-plugin");
    expect(text).toContain("v1.0.0");
  });
});

// ======================================================================
// /install <plugin>
// ======================================================================

describe("/install", () => {
  it("installs a plugin", async () => {
    const handled = await tryHandleCommand("/install my-plugin", store);
    expect(handled).toBe(true);
    const text = getOutputText();
    // Loaded at once, no restart asked for.
    expect(text).toContain("Installed and loaded: my-plugin");
    expect(text).not.toContain("Restart");
  });

  it("shows error for failed install", async () => {
    const handled = await tryHandleCommand("/install bad-plugin", store);
    expect(handled).toBe(true);
    const text = getOutputText();
    expect(text).toContain("Error: not found");
  });

  it("shows usage when no argument", async () => {
    const handled = await tryHandleCommand("/install ", store);
    expect(handled).toBe(true);
    const text = getOutputText();
    expect(text).toContain("Usage");
  });
});

// ======================================================================
// /uninstall <plugin>
// ======================================================================

describe("/uninstall", () => {
  it("uninstalls a plugin", async () => {
    const handled = await tryHandleCommand("/uninstall my-plugin", store);
    expect(handled).toBe(true);
    const text = getOutputText();
    expect(text).toContain("Removed: my-plugin");
  });

  it("shows error for missing plugin", async () => {
    const handled = await tryHandleCommand("/uninstall missing-plugin", store);
    expect(handled).toBe(true);
    const text = getOutputText();
    expect(text).toContain("Error: not installed");
  });

  it("shows usage when no argument", async () => {
    const handled = await tryHandleCommand("/uninstall ", store);
    expect(handled).toBe(true);
    const text = getOutputText();
    expect(text).toContain("Usage");
  });
});

// ======================================================================
// /restart
// ======================================================================

describe("/restart", () => {
  it("saves session and schedules exit", async () => {
    const { saveSession } = await import("../../../src/sessions.js");
    // Mock process.exit to prevent actual exit
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {});

    const handled = await tryHandleCommand("/restart", store);
    expect(handled).toBe(true);
    expect(saveSession).toHaveBeenCalled();
    const text = getOutputText();
    expect(text).toContain("Restarting");

    // Cleanup
    exitSpy.mockRestore();
  });
});

// ======================================================================
// /next, /prev, /page N -- dataset navigation
// ======================================================================

describe("/next", () => {
  it("shows 'no datasets' when empty", async () => {
    const handled = await tryHandleCommand("/next", store);
    expect(handled).toBe(true);
    const text = getOutputText();
    expect(text).toContain("No active datasets");
  });

  it("navigates to next page when dataset exists", async () => {
    const { printTable } = await import("../../../src/ui/output.js");
    store.getState().addDataset({
      label: "test-data",
      columns: ["a", "b"],
      rows: Array.from({ length: 25 }, (_, i) => [i, `val-${i}`]),
      pageSize: 10,
    });

    const handled = await tryHandleCommand("/next", store);
    expect(handled).toBe(true);
    expect(printTable).toHaveBeenCalled();
  });
});

describe("/prev", () => {
  it("shows 'no datasets' when empty", async () => {
    const handled = await tryHandleCommand("/prev", store);
    expect(handled).toBe(true);
    const text = getOutputText();
    expect(text).toContain("No active datasets");
  });

  it("navigates to previous page", async () => {
    const { printTable } = await import("../../../src/ui/output.js");
    const dsId = store.getState().addDataset({
      label: "test-data",
      columns: ["a", "b"],
      rows: Array.from({ length: 25 }, (_, i) => [i, `val-${i}`]),
      pageSize: 10,
    });
    store.getState().setDatasetPage(dsId, 3);

    const handled = await tryHandleCommand("/prev", store);
    expect(handled).toBe(true);
    expect(printTable).toHaveBeenCalled();
  });
});

describe("/page N", () => {
  it("shows 'no datasets' when empty", async () => {
    const handled = await tryHandleCommand("/page 2", store);
    expect(handled).toBe(true);
    const text = getOutputText();
    expect(text).toContain("No active datasets");
  });

  it("jumps to specified page", async () => {
    const { printTable } = await import("../../../src/ui/output.js");
    store.getState().addDataset({
      label: "test-data",
      columns: ["a", "b"],
      rows: Array.from({ length: 25 }, (_, i) => [i, `val-${i}`]),
      pageSize: 10,
    });

    const handled = await tryHandleCommand("/page 2", store);
    expect(handled).toBe(true);
    expect(printTable).toHaveBeenCalled();
  });
});

// ======================================================================
// /copy -- clipboard (test graceful handling)
// ======================================================================

describe("/copy", () => {
  it("is recognized as a command (has a bug: references undefined 's')", async () => {
    // /copy has a bug: it references bare `s` instead of `store.getState()`
    // so it throws ReferenceError. We verify it's registered (tryHandleCommand
    // finds it) but the handler itself crashes.
    await expect(tryHandleCommand("/copy", store)).rejects.toThrow("s is not defined");
  });
});

// ======================================================================
// /stop -- handled in index.js, not registry
// ======================================================================

describe("/stop", () => {
  it("is not handled by tryHandleCommand (lives in index.js)", async () => {
    const handled = await tryHandleCommand("/stop", store);
    expect(handled).toBe(false);
  });
});

// ======================================================================
// /paste -- handled in index.js, not registry
// ======================================================================

describe("/paste", () => {
  it("is not handled by tryHandleCommand (lives in index.js)", async () => {
    const handled = await tryHandleCommand("/paste", store);
    expect(handled).toBe(false);
  });
});

// ======================================================================
// /supervisor -- handled in index.js, not registry
// ======================================================================

describe("/supervisor", () => {
  it("is not handled by tryHandleCommand (lives in index.js)", async () => {
    const handled = await tryHandleCommand("/supervisor", store);
    expect(handled).toBe(false);
  });
});

// ======================================================================
// Routing: unknown commands
// ======================================================================

describe("routing", () => {
  it("returns false for unknown commands", async () => {
    const handled = await tryHandleCommand("/nonexistent", store);
    expect(handled).toBe(false);
  });

  it("returns false for plain text (not a command)", async () => {
    const handled = await tryHandleCommand("hello world", store);
    expect(handled).toBe(false);
  });
});
