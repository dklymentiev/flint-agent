// Integration tests: MCP client lifecycle — security validation, tool registration,
// connection management, and config parsing (Phase R8)

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock logger to suppress output
vi.mock("../../src/logging/logger.js", () => ({
  createLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
}));

// Mock MCP SDK transports — we don't connect to real servers
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: vi.fn(),
}));
vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: vi.fn(),
}));
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: vi.fn(),
}));
vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: vi.fn(),
}));

// Mock content-resolver (not under test)
vi.mock("../../src/agent/content-resolver.js", () => ({
  resolveContent: (blocks) => {
    const text = (blocks || []).filter(b => b.type === "text").map(b => b.text).join("\n");
    return { type: "text", text: text || "OK" };
  },
}));

// Mock security module
vi.mock("../../src/security/content-validator.js", () => ({
  detectBase64Content: () => ({ isBinary: false, detected: null }),
  validateContentType: () => true,
}));

const { connectMcpServers, getServerStatus, setMcpAbortSignal, disconnectAll } =
  await import("../../src/mcp-client.js");

// Registry is tested for MCP tool integration
const registry = await import("../../src/tools/registry.js");

// --- Helpers ---

/** Build a MCP_SERVERS env string */
function envStr(...entries) {
  return entries.join(",");
}

// ---------------------------------------------------------------------------

describe("MCP lifecycle — security validation", () => {

  it("rejects non-absolute path for stdio transport", async () => {
    const env = "bad|stdio|relative/path/to/server";
    const { results } = await connectMcpServers(env);
    expect(results[0].ok).toBe(false);
    expect(results[0].error).toMatch(/absolute path/i);
  });

  it("rejects non-http/https URL for SSE transport", async () => {
    const env = "evil|sse|ftp://malicious.server/sse";
    const { results } = await connectMcpServers(env);
    expect(results[0].ok).toBe(false);
    expect(results[0].error).toMatch(/unsupported.*scheme/i);
  });

  it("rejects non-http/https URL for HTTP transport", async () => {
    const env = "evil|http|file:///etc/passwd";
    const { results } = await connectMcpServers(env);
    expect(results[0].ok).toBe(false);
    expect(results[0].error).toMatch(/unsupported.*scheme/i);
  });

  it("rejects server name with special characters (stdio)", async () => {
    const env = "bad;name|stdio|/usr/bin/server";
    const { results } = await connectMcpServers(env);
    expect(results[0].ok).toBe(false);
    expect(results[0].error).toMatch(/alphanumeric/i);
  });

  it("accepts alphanumeric server names with dash/underscore (stdio)", async () => {
    // This will fail at connect() (mocked), but should NOT fail at name validation
    const env = "my-server_01|stdio|/usr/bin/server";
    const { results } = await connectMcpServers(env);
    // If it failed, it should NOT be a name validation error
    if (!results[0].ok) {
      expect(results[0].error).not.toMatch(/alphanumeric/i);
    }
  });
});

describe("MCP lifecycle — tool registration with registry", () => {

  beforeEach(() => {
    // Reset registry tools (re-init with empty store)
    // We can't fully reset, but we can verify additive behavior
  });

  it("MCP tools are prefixed with mcp_{serverName}_{toolName}", async () => {
    // Manually build what connectServer would produce
    const tools = [
      {
        type: "function",
        function: {
          name: "mcp_screenbox_screenshot",
          description: "Take a screenshot",
          parameters: { type: "object", properties: {} },
        },
      },
    ];
    const handlers = {
      mcp_screenbox_screenshot: async () => "ok",
    };

    registry.registerMcpTools(tools, handlers, [{ name: "screenbox", tools: 1, ok: true }]);

    const defs = registry.getDefinitions();
    const mcpTool = defs.find(t => t.function.name === "mcp_screenbox_screenshot");
    expect(mcpTool).toBeDefined();
    expect(mcpTool.type).toBe("function");
    expect(mcpTool.function.description).toBe("Take a screenshot");
  });

  it("registerMcpTools adds tools to registry and getDefinitions returns them", () => {
    const toolName = "mcp_memory_store";
    const tools = [
      {
        type: "function",
        function: {
          name: toolName,
          description: "Store in memory",
          parameters: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
        },
      },
    ];
    const handlers = { [toolName]: async () => "stored" };

    registry.registerMcpTools(tools, handlers, []);

    const defs = registry.getDefinitions();
    const found = defs.find(t => t.function.name === toolName);
    expect(found).toBeDefined();
    expect(found.function.parameters.required).toContain("key");
  });

  it("registered MCP handler is executable via executeTool", async () => {
    const toolName = "mcp_test_echo";
    const tools = [
      {
        type: "function",
        function: {
          name: toolName,
          description: "Echo",
          parameters: { type: "object", properties: { msg: { type: "string" } } },
        },
      },
    ];
    const handlers = { [toolName]: async (args) => `echo: ${args.msg}` };

    registry.registerMcpTools(tools, handlers, []);

    const result = await registry.executeTool(toolName, { msg: "hello" });
    expect(result).toBe("echo: hello");
  });
});

describe("MCP lifecycle — connection management", () => {

  it("getServerStatus returns correct structure for configured servers", () => {
    const env = "alpha|sse|http://localhost:8080/sse,beta|stdio|/usr/bin/beta-server";
    const status = getServerStatus(env);

    expect(status).toHaveLength(2);
    expect(status[0]).toEqual({
      name: "alpha",
      url: "http://localhost:8080/sse",
      transport: "sse",
      connected: expect.any(Boolean),
    });
    expect(status[1]).toEqual({
      name: "beta",
      url: "/usr/bin/beta-server",
      transport: "stdio",
      connected: expect.any(Boolean),
    });
  });

  it("getServerStatus returns empty array for empty env", () => {
    expect(getServerStatus("")).toEqual([]);
    expect(getServerStatus(undefined)).toEqual([]);
  });

  it("setMcpAbortSignal stores signal without error", () => {
    const ac = new AbortController();
    // Should not throw
    expect(() => setMcpAbortSignal(ac.signal)).not.toThrow();
    // Cleanup
    setMcpAbortSignal(null);
  });

  it("disconnectAll completes without error on empty clients", async () => {
    await expect(disconnectAll()).resolves.not.toThrow();
  });
});

describe("MCP lifecycle — MCP_SERVERS config parsing", () => {

  it("parses single server 'name|transport|url' format", () => {
    const env = "myserver|sse|http://localhost:9090/sse";
    const status = getServerStatus(env);
    expect(status).toHaveLength(1);
    expect(status[0].name).toBe("myserver");
    expect(status[0].transport).toBe("sse");
    expect(status[0].url).toBe("http://localhost:9090/sse");
  });

  it("parses multiple comma-separated servers", () => {
    const env = "a|sse|http://host1/sse,b|http|http://host2/api,c|stdio|/bin/c";
    const status = getServerStatus(env);
    expect(status).toHaveLength(3);
    expect(status.map(s => s.name)).toEqual(["a", "b", "c"]);
  });

  it("handles pipe characters in URL (e.g. stdio command with args)", () => {
    // The URL part can contain pipes because split("|") uses first two as name/transport
    // and the rest is joined back
    const env = "mem|stdio|/usr/bin/agent-memory|mcp|--flag";
    const status = getServerStatus(env);
    expect(status).toHaveLength(1);
    // URL should be "/usr/bin/agent-memory|mcp|--flag" (everything after name|transport)
    expect(status[0].url).toBe("/usr/bin/agent-memory|mcp|--flag");
  });

  it("filters out malformed entries with missing name or URL", () => {
    const env = "|sse|http://host/sse,valid|sse|http://host2/sse,nourl|sse|";
    const status = getServerStatus(env);
    // Only "valid" should survive — first has no name, third has no url
    expect(status).toHaveLength(1);
    expect(status[0].name).toBe("valid");
  });

  it("returns empty array for empty or undefined config", () => {
    expect(getServerStatus("")).toEqual([]);
    expect(getServerStatus(null)).toEqual([]);
    expect(getServerStatus(undefined)).toEqual([]);
  });
});
