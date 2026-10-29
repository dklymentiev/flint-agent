// --tools / --disallowedTools: a tool the host left out is not in the model's
// list, cannot be found by tool_search and is refused when called by name.
// Before, the flags were accepted and ignored, and FLINT_TOOL_ALLOWLIST only
// trimmed the list: tool_search still loaded a hidden tool and executeTool
// still ran one.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { initRegistry, executeTool, getDefinitions, registerMcpTools, setToolFilter } from "../../../src/tools/registry.js";
import { toolFilterFrom } from "../../../src/tools/tool-filter.js";
import { parseStdioArgs } from "../../../src/stdio/args.js";
import { createMockStore } from "../../helpers/mock-store.js";

const names = () => getDefinitions().map((t) => t.function.name);

function mcpTool(name) {
  return { type: "function", function: { name, description: `${name} of the messaging server`, parameters: { type: "object", properties: {} } } };
}

beforeEach(() => {
  initRegistry(createMockStore());
  registerMcpTools(
    [mcpTool("mcp_messaging_send"), mcpTool("mcp_messaging_read"), mcpTool("mcp_reminders_add")],
    { mcp_messaging_send: () => "sent", mcp_messaging_read: () => "read", mcp_reminders_add: () => "added" },
    [],
  );
});

afterEach(() => setToolFilter(null));

describe("toolFilterFrom", () => {
  it("is null without flags: standalone Flint keeps every tool", () => {
    expect(toolFilterFrom({})).toBeNull();
  });

  it("takes Flint names, Claude Code names and Claude Code MCP names", () => {
    const allow = toolFilterFrom({ tools: "Read, WebSearch think mcp__messaging mcp__reminders__add Bash(git *)" });
    for (const n of ["read_file", "web_search", "think", "mcp_messaging_send", "mcp_messaging_read", "mcp_reminders_add", "run_command"]) {
      expect(allow(n), n).toBe(true);
    }
    for (const n of ["write_file", "add_task", "mcp_reminders_list"]) expect(allow(n), n).toBe(false);
  });

  it("--disallowedTools wins over --tools", () => {
    const allow = toolFilterFrom({ tools: "mcp__messaging", disallowedTools: "mcp__messaging__send" });
    expect(allow("mcp_messaging_read")).toBe(true);
    expect(allow("mcp_messaging_send")).toBe(false);
  });
});

describe("a filtered registry", () => {
  beforeEach(() => setToolFilter(toolFilterFrom({ tools: "read_file,think,tool_search,mcp__messaging" })));

  it("sends the model only the allowed tools", () => {
    expect(names().sort()).toEqual(["mcp_messaging_read", "mcp_messaging_send", "read_file", "think", "tool_search"]);
  });

  it("tool_search does not find a tool that was left out", async () => {
    const out = await executeTool("tool_search", { query: "reminders add" });
    expect(out).not.toContain("mcp_reminders_add");
  });

  it("refuses a call by name, also one a typo repair would reach", async () => {
    expect(await executeTool("mcp_reminders_add", {})).toMatch(/not available/);
    expect(await executeTool("run_comand", { command: "echo hi" })).not.toContain("hi");
    expect(await executeTool("mcp_messaging_send", {})).toBe("sent");
  });
});

describe("stdio flags", () => {
  it("passes --tools and --disallowedTools on, in both spellings", () => {
    const a = parseStdioArgs(["node", "flint", "--stdio", "--tools", "Read,Bash", "--disallowed-tools", "Bash"]);
    expect(a.tools).toBe("Read,Bash");
    expect(a.disallowedTools).toBe("Bash");
    const b = parseStdioArgs(["node", "flint", "--stdio", "--disallowedTools=Write"]);
    expect(b.disallowedTools).toBe("Write");
  });
});
