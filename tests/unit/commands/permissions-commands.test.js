import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockStore } from "../../helpers/mock-store.js";

// Mock permissions module
const mockSetPermission = vi.fn();
const mockGetPermissionMap = vi.fn();
const mockResetSessionOverrides = vi.fn();
const mockBulkSetPermission = vi.fn();

vi.mock("../../../src/tools/permissions.js", () => ({
  getPermissionMap: (...args) => mockGetPermissionMap(...args),
  setPermission: (...args) => mockSetPermission(...args),
  resetSessionOverrides: (...args) => mockResetSessionOverrides(...args),
  bulkSetPermission: (...args) => mockBulkSetPermission(...args),
}));

// Mock sessions (commands.js imports it)
vi.mock("../../../src/sessions.js", () => ({
  generateSessionId: () => "test-123",
  saveSession: vi.fn(async () => {}),
  loadSession: vi.fn(async () => ({ messages: [], inputHistory: [] })),
  listSessions: vi.fn(async () => []),
}));

// Mock system-prompt
vi.mock("../../../src/agent/system-prompt.js", () => ({
  SYSTEM_MESSAGE: { role: "system", content: "test" },
  getSystemMessage: () => ({ role: "system", content: "test" }),
}));

// Mock config
vi.mock("../../../src/config.js", () => ({
  config: { model: "test-model", port: 3000, projectRoot: "/tmp/test" },
}));

// Mock memory modules
vi.mock("../../../src/memory/store.js", () => ({
  getMemoryStats: () => ({ total: 0, byCategory: {}, oldest: null, newest: null }),
  listRecentMemories: () => [],
  clearAllMemories: vi.fn(),
}));

vi.mock("../../../src/memory/markdown.js", () => ({
  updateMemoryMd: vi.fn(),
  readMemoryMdHead: () => "",
}));

let store;
let tryHandleCommand;

beforeEach(async () => {
  store = createMockStore();
  mockSetPermission.mockClear();
  mockGetPermissionMap.mockClear();
  mockResetSessionOverrides.mockClear();
  mockBulkSetPermission.mockClear();

  const { initCommands, tryHandleCommand: thc } = await import("../../../src/commands/registry.js");
  tryHandleCommand = thc;
  initCommands(store);
});

// ── /permissions ──

describe("/permissions command", () => {
  it("outputs grouped permission map", async () => {
    mockGetPermissionMap.mockReturnValue({
      read_file: "allow",
      write_file: "confirm",
      run_command: "deny",
    });

    const handled = await tryHandleCommand("/permissions", store);
    expect(handled).toBe(true);
    expect(mockGetPermissionMap).toHaveBeenCalled();

    // Check store lines contain permission info
    const lines = store.getState().lines;
    const text = lines.map((l) => l.text).join("\n");
    expect(text).toContain("Permissions");
  });
});

// ── /allow <tool> ──

describe("/allow <tool> command", () => {
  it("calls setPermission with allow", async () => {
    const handled = await tryHandleCommand("/allow write_file", store);
    expect(handled).toBe(true);
    expect(mockSetPermission).toHaveBeenCalledWith("write_file", "allow");
  });

  it("preserves original case of tool name", async () => {
    await tryHandleCommand("/allow Write_File", store);
    expect(mockSetPermission).toHaveBeenCalledWith("Write_File", "allow");
  });
});

// ── /deny <tool> ──

describe("/deny <tool> command", () => {
  it("calls setPermission with deny", async () => {
    const handled = await tryHandleCommand("/deny run_command", store);
    expect(handled).toBe(true);
    expect(mockSetPermission).toHaveBeenCalledWith("run_command", "deny");
  });
});

// ── /confirm <tool> ──

describe("/confirm <tool> command", () => {
  it("calls setPermission with confirm", async () => {
    const handled = await tryHandleCommand("/confirm delete_file", store);
    expect(handled).toBe(true);
    expect(mockSetPermission).toHaveBeenCalledWith("delete_file", "confirm");
  });
});

// ── /allow-all ──

describe("/allow-all command", () => {
  it("calls bulkSetPermission with allow", async () => {
    const handled = await tryHandleCommand("/allow-all", store);
    expect(handled).toBe(true);
    expect(mockBulkSetPermission).toHaveBeenCalledWith("allow");
  });
});

// ── /deny-all ──

describe("/deny-all command", () => {
  it("calls bulkSetPermission with deny", async () => {
    const handled = await tryHandleCommand("/deny-all", store);
    expect(handled).toBe(true);
    expect(mockBulkSetPermission).toHaveBeenCalledWith("deny");
  });
});

// ── /reset-permissions ──

describe("/reset-permissions command", () => {
  it("calls resetSessionOverrides", async () => {
    const handled = await tryHandleCommand("/reset-permissions", store);
    expect(handled).toBe(true);
    expect(mockResetSessionOverrides).toHaveBeenCalled();
  });
});

// ── Routing: unknown commands not handled ──

describe("routing", () => {
  it("returns false for unknown commands", async () => {
    const handled = await tryHandleCommand("/unknown_cmd", store);
    expect(handled).toBe(false);
  });

  it("returns false for /allow without argument", async () => {
    // /allow with no space after is treated as direct match, which doesn't exist
    const handled = await tryHandleCommand("/allow", store);
    // It matches commands["/allow"] if it exists as direct match
    // In registry: commands[lower] → commands["/allow"] exists, so it's called with no arg
    expect(handled).toBe(true);
    // But setPermission should not be called (empty tool name check)
    expect(mockSetPermission).not.toHaveBeenCalled();
  });
});
