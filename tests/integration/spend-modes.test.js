// Spend modes end to end (docs/spend-modes.md, S4, S5).
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../../src/logging/logger.js", () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}));

afterEach(() => { delete process.env.FLINT_SPEND; });

const def = (name) => ({ type: "function", function: { name, description: name } });
const tools = [def("read_file"), def("run_command"), def("tool_search"), ...Array.from({ length: 40 }, (_, i) => def(`mcp_big_tool${i + 1}`))];

describe("spend modes", () => {
  it("S4 the level decides whether a 40-tool MCP server is offered whole", async () => {
    const { classifyIntent } = await import("../../src/agent/intent.js");
    const { config } = await import("../../src/config.js");
    config.intentModel = null;
    config.fallbackAllTools = false;
    const offered = async (level) => {
      process.env.FLINT_SPEND = level;
      return (await classifyIntent({ newMessage: "go", availableTools: tools })).tools;
    };
    expect(await offered("normal")).not.toContain("mcp_big_tool1");
    expect(await offered("generous")).toContain("mcp_big_tool40");
    expect(await offered("economy")).not.toContain("mcp_big_tool1");
  });

  it("S5 the token-saving advice is in the system prompt in economy only", async () => {
    const prompt = async (level) => {
      process.env.FLINT_SPEND = level;
      vi.resetModules();
      const { getSystemMessage } = await import("../../src/agent/system-prompt.js");
      return JSON.stringify(getSystemMessage(null, {}));
    };
    expect(await prompt("economy")).toContain("Spending tokens (economy mode)");
    expect(await prompt("normal")).not.toContain("Spending tokens");
    expect(await prompt("generous")).not.toContain("Spending tokens");
  }, 30000);
});
