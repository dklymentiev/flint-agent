// Test that the model is told the real tool name on first use of a synonym.
// The announcement appears in the result TEXT (what the model sees), once
// per synonym per session, not repeated.

import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "synonym-announce-"));
const sessionsDir = path.join(tmpBase, "sessions");

const mockExecuteTool = vi.fn(async (name) => `result:${name}`);

// vi.mock is hoisted — factories cannot reference top-level variables.
// Use vi.hoisted for the values we need.
const { tmpBaseHoisted, sessionsDirHoisted } = vi.hoisted(() => {
  const fs = require("node:fs");
  const path = require("node:path");
  const os = require("node:os");
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "synonym-announce-"));
  return { tmpBaseHoisted: base, sessionsDirHoisted: path.join(base, "sessions") };
});

vi.mock("../../../src/config.js", () => ({
  config: { projectRoot: tmpBaseHoisted, sessionsDir: sessionsDirHoisted },
}));

vi.mock("../../../src/tools/registry.js", () => ({
  executeTool: (...args) => mockExecuteTool(...args),
  getDefinitions: () => [
    { type: "function", function: { name: "read_file" } },
    { type: "function", function: { name: "list_directory" } },
    { type: "function", function: { name: "write_file" } },
    { type: "function", function: { name: "run_command" } },
    { type: "function", function: { name: "think" } },
    { type: "function", function: { name: "search_in_files" } },
    { type: "function", function: { name: "glob" } },
  ],
}));

import { executeToolWithPermissions, resetSynonymAnnouncements, initPermissions } from "../../../src/tools/permissions.js";

beforeEach(() => {
  mockExecuteTool.mockClear();
  resetSynonymAnnouncements();
});

describe("synonym announcement in result text", () => {
  it("first call with shell includes the real name announcement in result", async () => {
    initPermissions({ confirm: vi.fn(async () => "yes") });

    const { result } = await executeToolWithPermissions("shell", { command: "ls" });
    expect(result).toContain("run_command");
    // The announcement names both names
    expect(result).toMatch(/shell.*run_command|run_command.*shell/);
  });

  it("second call with same synonym shell does NOT repeat the announcement", async () => {
    initPermissions({ confirm: vi.fn(async () => "yes") });

    const { result: result1 } = await executeToolWithPermissions("shell", { command: "ls" });
    const { result: result2 } = await executeToolWithPermissions("shell", { command: "ls" });

    expect(result1).toMatch(/shell.*run_command|run_command.*shell/);
    expect(result2).not.toMatch(/shell.*run_command|run_command.*shell/);
    expect(result2).toBe("result:run_command");
  });

  it("different synonyms get independent announcements", async () => {
    initPermissions({ confirm: vi.fn(async () => "yes") });

    const { result: r1 } = await executeToolWithPermissions("shell", { command: "ls" });
    const { result: r2 } = await executeToolWithPermissions("read", { path: "x.txt" });

    expect(r1).toMatch(/shell.*run_command|run_command.*shell/);
    expect(r2).toMatch(/read.*read_file|read_file.*read/);
  });
});

describe("resolved name and per-session announcement", () => {
  it("returns the real tool name for a synonym, the same name otherwise", async () => {
    initPermissions({ confirm: vi.fn(async () => "yes") });
    expect((await executeToolWithPermissions("bash", { command: "ls" })).name).toBe("run_command");
    expect((await executeToolWithPermissions("read_file", { path: "x" })).name).toBe("read_file");
  });

  it("announces again in a new session, not twice in the same one", async () => {
    initPermissions({ confirm: vi.fn(async () => "yes") });
    const a1 = await executeToolWithPermissions("shell", { command: "ls" }, { sessionId: "A" });
    const a2 = await executeToolWithPermissions("shell", { command: "ls" }, { sessionId: "A" });
    const b1 = await executeToolWithPermissions("shell", { command: "ls" }, { sessionId: "B" });
    expect(a1.result).toContain("alias");
    expect(a2.result).not.toContain("alias");
    expect(b1.result).toContain("alias");
  });

  it("puts the announcement on a table result as _announcement", async () => {
    initPermissions({ confirm: vi.fn(async () => "yes") });
    mockExecuteTool.mockResolvedValueOnce({ _table: true, title: "t", columns: ["a"], rows: [["1"]] });
    const { result } = await executeToolWithPermissions("ls", { path: "." }, { sessionId: "T" });
    expect(result._announcement).toContain("ls is an alias for list_directory");
  });

  // An image result has no text the notice can be put in front of, and before
  // 57e384b it fell through every branch: the model was never told.
  it("puts the announcement on an image result as _announcement", async () => {
    initPermissions({ confirm: vi.fn(async () => "yes") });
    mockExecuteTool.mockResolvedValueOnce({ _image: true, data: "AAAA", format: "png" });
    const { result } = await executeToolWithPermissions("ls", { path: "." }, { sessionId: "I" });
    expect(result._image).toBe(true);
    expect(result._announcement).toContain("ls is an alias for list_directory");
  });
});

// A refused call is where the resolved name matters most: the agent counts
// refusals per tool name to end a denial loop, and "bash" refused three times
// must count as run_command refused three times. Only the allowed path was
// checked for `name`; each refusal returns from its own line.
describe("a refused synonym call still reports the real tool name", () => {
  it("when a rule denies the tool", async () => {
    const perms = await import("../../../src/tools/permissions.js");
    initPermissions({ confirm: vi.fn(async () => "yes") });
    perms.setPermission("run_command", "deny");
    try {
      const out = await executeToolWithPermissions("bash", { command: "ls" });
      expect(out.denied).toBe(true);
      expect(out.name).toBe("run_command");
    } finally {
      perms.resetPermissionState();
    }
  });

  it("when the operator says no", async () => {
    const perms = await import("../../../src/tools/permissions.js");
    initPermissions({ confirm: vi.fn(async () => "no") });
    perms.setPermission("run_command", "confirm");
    try {
      const out = await executeToolWithPermissions("bash", { command: "ls" });
      expect(out.denied).toBe(true);
      expect(out.name).toBe("run_command");
    } finally {
      perms.resetPermissionState();
    }
  });

  it("when nobody is attached to ask", async () => {
    const perms = await import("../../../src/tools/permissions.js");
    initPermissions({ confirm: vi.fn(async () => "yes") });
    perms.setPermission("run_command", "confirm");
    perms.setUnattended(true);
    try {
      const out = await executeToolWithPermissions("bash", { command: "ls" });
      expect(out.denied).toBe(true);
      expect(out.name).toBe("run_command");
    } finally {
      perms.resetPermissionState();
    }
  });

  // Last in the file: a hook cannot be removed once added. It only refuses the
  // call that asks for it.
  it("when a hook denies the call", async () => {
    const perms = await import("../../../src/tools/permissions.js");
    initPermissions({ confirm: vi.fn(async () => "yes") });
    perms.addBeforeHook((name, args) => (args?.refuseMe ? { deny: true, reason: "test" } : null));
    const out = await executeToolWithPermissions("bash", { command: "ls", refuseMe: true });
    expect(out.denied).toBe(true);
    expect(out.name).toBe("run_command");
  });
});
