import { describe, it, expect, beforeEach } from "vitest";
import { initRegistry, executeTool, getDefinitions, registerMcpTools } from "../../../src/tools/registry.js";
import { noteMcpTool } from "../../../src/tools/mcp-tool-servers.js";
import { createMockStore } from "../../helpers/mock-store.js";
import { createTmpDir } from "../../helpers/tmp-dir.js";
import fs from "node:fs";
import path from "node:path";

let store;

beforeEach(() => {
  store = createMockStore();
  initRegistry(store);
});

describe("executeTool", () => {
  it("dispatches to correct handler for known tool", async () => {
    const tmp = createTmpDir();
    try {
      const filePath = path.join(tmp.path, "test.txt");
      fs.writeFileSync(filePath, "hello registry");
      const result = await executeTool("read_file", { path: filePath });
      expect(result).toBe("hello registry");
    } finally {
      tmp.cleanup();
    }
  });

  it("returns error for unknown tool", async () => {
    const result = await executeTool("nonexistent_tool", {});
    expect(result).toContain("unknown tool");
    expect(result).toContain("nonexistent_tool");
  });

  it("catches handler errors", async () => {
    const result = await executeTool("read_file", { path: "/this/path/does/not/exist/ever" });
    expect(result).toContain("Error:");
  });
});

describe("schema validation", () => {
  it("rejects missing required parameter", async () => {
    const result = await executeTool("read_file", {});
    expect(result).toContain("invalid parameters");
    expect(result).toContain('missing required parameter: "path"');
  });

  it("rejects wrong type — string expected, got number", async () => {
    const result = await executeTool("read_file", { path: 12345 });
    expect(result).toContain("invalid parameters");
    expect(result).toContain('"path" must be string');
  });

  it("rejects wrong type — integer expected, got string", async () => {
    const result = await executeTool("read_file", { path: "/tmp/x", offset: "abc" });
    expect(result).toContain('"offset" must be integer');
  });

  it("accepts valid args", async () => {
    const result = await executeTool("read_file", { path: "/nonexistent/file.txt" });
    // Should not be a validation error — should be a file-not-found error
    expect(result).not.toContain("invalid parameters");
  });

  it("tolerates extra fields from LLM", async () => {
    const result = await executeTool("read_file", { path: "/nonexistent/file.txt", extra_field: true });
    expect(result).not.toContain("invalid parameters");
  });
});

describe("MCP numeric parameters", () => {
  it("converts numeric strings according to the MCP schema", async () => {
    const name = "mcp_dataforseo_serp_organic";
    let received;
    registerMcpTools([{
      type: "function",
      function: { name, parameters: { type: "object", properties: {
        keyword: { type: "string" }, depth: { type: "integer" }, score: { type: "number" },
      } } },
    }], { [name]: async (args) => { received = args; return "ok"; } }, []);
    noteMcpTool(name, "dataforseo");

    expect(await executeTool(name, { keyword: "merge pdf", depth: "20", score: "0.5" })).toBe("ok");
    expect(received).toEqual({ keyword: "merge pdf", depth: 20, score: 0.5 });
    expect(await executeTool(name, { keyword: "merge pdf", depth: "20px" })).toContain('"depth" must be integer');
  });
});

describe("getDefinitions", () => {
  it("returns all tool definitions after initRegistry", () => {
    const defs = getDefinitions();
    expect(defs.length).toBeGreaterThan(0);
    const names = defs.map((d) => d.function.name);
    expect(names).toContain("read_file");
    expect(names).toContain("write_file");
    expect(names).toContain("run_command");
    expect(names).toContain("think");
    expect(names).toContain("glob");
  });
});
