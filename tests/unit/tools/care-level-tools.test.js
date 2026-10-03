// The care level decides which tools ask, not only which commands
// (owner, 2026-10-01: every run_command and write asked at every level).
import { describe, it, expect } from "vitest";
import { toolPermissionAtLevel } from "../../../src/security/policies.js";

describe("toolPermissionAtLevel", () => {
  it("safe keeps every confirm", () => {
    for (const t of ["write_file", "run_command", "delete_file", "mcp_x_send"]) {
      expect(toolPermissionAtLevel("safe", t, "confirm")).toBe("confirm");
    }
  });
  it("normal runs file edits and commands without asking", () => {
    for (const t of ["write_file", "edit_file", "run_command", "run_background_command"]) {
      expect(toolPermissionAtLevel("normal", t, "confirm")).toBe("allow");
    }
  });
  it("normal still asks about deletes, agents, mail and unknown tools", () => {
    for (const t of ["delete_file", "spawn_agent", "send_gmail_message", "mcp_x_send", "install_plugin", "reconnect_mcp"]) {
      expect(toolPermissionAtLevel("normal", t, "confirm")).toBe("confirm");
    }
  });
  it("permissive asks nothing by default, except deleting a file", () => {
    expect(toolPermissionAtLevel("permissive", "delete_file", "confirm")).toBe("confirm");
    expect(toolPermissionAtLevel("permissive", "reconnect_mcp", "confirm")).toBe("confirm");
    expect(toolPermissionAtLevel("permissive", "spawn_agent", "confirm")).toBe("allow");
    expect(toolPermissionAtLevel("permissive", "mcp_x_send", "confirm")).toBe("allow");
  });
  it("never turns a deny into anything else", () => {
    for (const lvl of ["safe", "normal", "permissive"]) {
      expect(toolPermissionAtLevel(lvl, "run_command", "deny")).toBe("deny");
    }
  });
});

