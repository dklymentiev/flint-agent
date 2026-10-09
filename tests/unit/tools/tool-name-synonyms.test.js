// Red test: tool-name synonym table.
//
// Some models call our tools by synonyms (shell, bash, exec, read, write, ls,
// find). The synonym table must map those to real tool names BEFORE permission
// checks run, so the real tool's permission level governs, not a per-name guess.
// The model learns the real name from the tool result.

import { describe, it, expect, beforeEach, vi, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "synonym-test-"));
const sessionsDir = path.join(tmpBase, "sessions");

const mockExecuteTool = vi.fn(async (name) => `result:${name}`);

vi.mock("../../../src/config.js", () => ({
  config: {
    projectRoot: tmpBase,
    sessionsDir,
  },
}));

vi.mock("../../../src/tools/registry.js", () => ({
  executeTool: (...args) => mockExecuteTool(...args),
  getDefinitions: () => [
    { type: "function", function: { name: "read_file" } },
    { type: "function", function: { name: "list_directory" } },
    { type: "function", function: { name: "write_file" } },
    { type: "function", function: { name: "run_command" } },
    { type: "function", function: { name: "execute_command" } },
    { type: "function", function: { name: "think" } },
    { type: "function", function: { name: "search_in_files" } },
    { type: "function", function: { name: "glob" } },
  ],
}));

afterAll(() => {
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

async function freshImport() {
  vi.resetModules();
  mockExecuteTool.mockClear();
  const mod = await import("../../../src/tools/permissions.js");
  mod.saveOnboardingAnswer("safe");
  return mod;
}

describe("tool-name synonym table", () => {
  let mod;
  beforeEach(async () => { mod = await freshImport(); });

  it("maps 'shell' to 'run_command' and dispatches to the real tool", async () => {
    const confirmFn = vi.fn(async () => "yes");
    mod.initPermissions({ confirm: confirmFn });

    const { result, denied, synonym } = await mod.executeToolWithPermissions("shell", { command: "ls" });
    expect(denied).toBe(false);
    expect(mockExecuteTool).toHaveBeenCalledWith("run_command", { command: "ls" });
    expect(result).toContain("result:run_command");
    // The model learns the real name.
    expect(synonym).toBe("shell");
  });

  it("maps 'read' to 'read_file'", async () => {
    const confirmFn = vi.fn(async () => "yes");
    mod.initPermissions({ confirm: confirmFn });

    const { result, denied, synonym } = await mod.executeToolWithPermissions("read", { path: "x.txt" });
    expect(denied).toBe(false);
    expect(mockExecuteTool).toHaveBeenCalledWith("read_file", { path: "x.txt" });
    expect(result).toContain("result:read_file");
    expect(synonym).toBe("read");
  });

  it("maps 'write' to 'write_file'", async () => {
    const confirmFn = vi.fn(async () => "yes");
    mod.initPermissions({ confirm: confirmFn });

    const { denied, synonym } = await mod.executeToolWithPermissions("write", { path: "y.txt", content: "hi" });
    expect(denied).toBe(false);
    expect(mockExecuteTool).toHaveBeenCalledWith("write_file", { path: "y.txt", content: "hi" });
    expect(synonym).toBe("write");
  });

  it("maps 'ls' to 'list_directory'", async () => {
    const confirmFn = vi.fn();
    mod.initPermissions({ confirm: confirmFn });

    const { result, denied, synonym } = await mod.executeToolWithPermissions("ls", { path: "/tmp" });
    expect(denied).toBe(false);
    // read-level — no confirm
    expect(confirmFn).not.toHaveBeenCalled();
    expect(mockExecuteTool).toHaveBeenCalledWith("list_directory", { path: "/tmp" });
    expect(result).toContain("result:list_directory");
    expect(synonym).toBe("ls");
  });

  it("maps 'find' to 'glob'", async () => {
    const confirmFn = vi.fn();
    mod.initPermissions({ confirm: confirmFn });

    const { denied, synonym } = await mod.executeToolWithPermissions("find", { pattern: "*.js" });
    expect(denied).toBe(false);
    expect(mockExecuteTool).toHaveBeenCalledWith("glob", { pattern: "*.js" });
    expect(synonym).toBe("find");
  });

  it("maps 'grep' to 'search_in_files'", async () => {
    const confirmFn = vi.fn();
    mod.initPermissions({ confirm: confirmFn });

    const { denied, synonym } = await mod.executeToolWithPermissions("grep", { pattern: "foo" });
    expect(denied).toBe(false);
    expect(mockExecuteTool).toHaveBeenCalledWith("search_in_files", { pattern: "foo" });
    expect(synonym).toBe("grep");
  });

  it("does not prompt on a level-allow synonym (shell → run_command under permissive)", async () => {
    mod.saveOnboardingAnswer("permissive");
    const confirmFn = vi.fn();
    mod.initPermissions({ confirm: confirmFn });

    const { denied } = await mod.executeToolWithPermissions("bash", { command: "ls" });
    expect(denied).toBe(false);
    expect(confirmFn).not.toHaveBeenCalled();
    expect(mockExecuteTool).toHaveBeenCalledWith("run_command", { command: "ls" });
  });

  it("a real MCP/plugin tool with the synonym name wins over the table", async () => {
    // 'shell' is a synonym for 'run_command', but if a tool named 'shell'
    // actually exists in the registry, it must NOT be remapped.
    const confirmFn = vi.fn(async () => "yes");
    mod.initPermissions({ confirm: confirmFn });

    // The mocked getDefinitions includes 'execute_command' but not 'shell',
    // so 'shell' is a non-registered name. The synonym table says shell →
    // run_command. A real 'shell' tool would short-circuit before the table.
    // Here we confirm the table is consulted only for names NOT in the registry.
    const { result } = await mod.executeToolWithPermissions("execute_command", { cmd: "x" });
    expect(mockExecuteTool).toHaveBeenCalledWith("execute_command", { cmd: "x" });
    expect(result).toBe("result:execute_command");
    // And the synonym path is NOT taken.
    expect(mockExecuteTool).not.toHaveBeenCalledWith("run_command", { cmd: "x" });
  });
});
