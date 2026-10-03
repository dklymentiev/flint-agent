// With the classifier off, MCP tools are offered, not hidden (2026-10-02).
//
// The fallback handed the model the built-in tools only, and an operator who
// had connected Screenbox got "I have no Screenbox tools". A few MCP tools now
// go in whole; past MCP_INLINE_MAX the model gets tool_search, whose
// description lists each server with a few tool names and "+N more".
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../src/logging/logger.js", () => ({
  createLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
}));

const { classifyIntent, mcpInlineMax } = await import("../../../src/agent/intent.js");
const MCP_INLINE_MAX = mcpInlineMax({}, "normal");
const { config } = await import("../../../src/config.js");
const { mcpCatalog, toolSearchDefWith, toolSearchDef, resetLoadedTools, createToolSearchHandler, CATALOG_NAMES_PER_SERVER } =
  await import("../../../src/tools/tool-search.js");

const def = (name, description = name) => ({ type: "function", function: { name, description } });
const builtins = [def("read_file"), def("run_command"), def("tool_search")];
const mcpTools = (server, n) => Array.from({ length: n }, (_, i) => def(`mcp_${server}_tool${i + 1}`));
const offered = async (availableTools) =>
  (await classifyIntent({ newMessage: "open a page", availableTools })).tools;

beforeEach(() => {
  resetLoadedTools();
  config.intentModel = null;
  config.fallbackAllTools = false;
});

describe("which tools a turn gets with the classifier off", () => {
  it("a few MCP tools go in whole (Screenbox has 23)", async () => {
    const tools = await offered([...builtins, ...mcpTools("screenbox", 23)]);
    expect(tools).toContain("mcp_screenbox_tool23");
  });

  it("past the limit: the built-ins and tool_search, not the MCP schemas", async () => {
    const tools = await offered([...builtins, ...mcpTools("big", MCP_INLINE_MAX + 1)]);
    expect(tools).toEqual(["read_file", "run_command", "tool_search"]);
  });

  it("past the limit, a tool a search loaded stays in hand", async () => {
    const all = [...builtins, ...mcpTools("big", MCP_INLINE_MAX + 1)];
    createToolSearchHandler(() => all)({ query: "big tool7", limit: 1 });
    const tools = await offered(all);
    expect(tools).toContain("mcp_big_tool7");
  });
});

describe("the catalog tool_search shows", () => {
  it("one line per server: a few names, then how many more", () => {
    const all = [...builtins, ...mcpTools("screenbox", 23), ...mcpTools("mail", 2)];
    const text = mcpCatalog(all, ["read_file"]);
    const lines = text.split("\n");
    expect(lines[0]).toBe(`- screenbox: tool1, tool2, tool3, tool4, +${23 - CATALOG_NAMES_PER_SERVER} more`);
    expect(lines[1]).toBe("- mail: tool1, tool2");
  });

  it("leaves out what is already in hand, and is empty when nothing is left", () => {
    const all = mcpTools("mail", 2);
    expect(mcpCatalog(all, ["mcp_mail_tool1"])).toBe("- mail: tool2");
    expect(mcpCatalog(all, ["mcp_mail_tool1", "mcp_mail_tool2"])).toBe("");
  });

  it("goes into tool_search's description, which is otherwise unchanged", () => {
    const withCatalog = toolSearchDefWith("- screenbox: desktop_chrome, +22 more");
    expect(withCatalog.function.description).toContain(toolSearchDef.function.description);
    expect(withCatalog.function.description).toContain("- screenbox: desktop_chrome, +22 more");
    expect(withCatalog.function.parameters).toBe(toolSearchDef.function.parameters);
    expect(toolSearchDefWith("")).toBe(toolSearchDef);
  });
});
