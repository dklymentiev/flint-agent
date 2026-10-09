// An MCP tool's number, array or object that a model sent as a string reaches
// the handler with its real type; a string that does not parse to that type is
// still rejected by the validator.

import { describe, it, expect, beforeEach } from "vitest";
import { initRegistry, registerMcpTools, executeTool } from "../../../src/tools/registry.js";
import { noteMcpTool } from "../../../src/tools/mcp-tool-servers.js";
import { createMockStore } from "../../helpers/mock-store.js";

const NAME = "mcp_fakeseo_probe";
let seen;

beforeEach(() => {
  initRegistry(createMockStore());
  seen = null;
  noteMcpTool(NAME, "fakeseo");
  registerMcpTools(
    [{
      type: "function",
      function: {
        name: NAME,
        description: "probe",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            max_results: { type: "integer" },
            ratio: { type: "number" },
            keywords: { type: "array" },
            payload: { type: "object" },
          },
          required: ["path"],
        },
      },
    }],
    { [NAME]: async (args) => { seen = args; return "ok"; } },
    { name: "fakeseo", tools: 1, ok: true },
  );
});

describe("MCP argument normalization", () => {
  it("turns string numbers, arrays and objects into their real types", async () => {
    const r = await executeTool(NAME, {
      path: "x", max_results: "100", ratio: "0.5",
      keywords: '["a","b"]', payload: '{"k":[1]}',
    });
    expect(r).toBe("ok");
    expect(seen).toEqual({ path: "x", max_results: 100, ratio: 0.5, keywords: ["a", "b"], payload: { k: [1] } });
  });

  it("leaves a string that is not the right type to the validator", async () => {
    const r = await executeTool(NAME, { path: "x", max_results: "ten", keywords: "a,b", payload: "[1]" });
    expect(r).toMatch(/invalid parameters/);
    expect(r).toMatch(/max_results/);
    expect(r).toMatch(/keywords/);
    expect(r).toMatch(/payload/);
  });

  it("does not touch a string where the schema wants a string", async () => {
    await executeTool(NAME, { path: "100" });
    expect(seen).toEqual({ path: "100" });
  });
});
