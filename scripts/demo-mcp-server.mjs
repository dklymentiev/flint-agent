/**
 * Demo stdio MCP server, used to show that an agent can configure an
 * MCP server into Flint itself. Not production code: one ping tool and
 * one greet tool, no dependencies beyond the MCP SDK already in node_modules.
 *
 * Register in .env:   MCP_SERVERS=demo|stdio|<node-short-path> <path-to-this-file>
 * or in .mcp.json:    {"mcpServers": {"demo": {"command": "node", "args": ["<this-file>"]}}}
 */
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer({ name: "flint-demo", version: "1.0.0" });

server.registerTool(
  "ping",
  {
    title: "Ping",
    description: "Demo tool: replies with the current time.",
    inputSchema: {},
  },
  async () => ({
    content: [{ type: "text", text: `pong from flint-demo @ ${new Date().toISOString()}` }],
  })
);

server.registerTool(
  "greet",
  {
    title: "Greet",
    description: "Demo tool: greets the named person.",
    inputSchema: { name: z.string().describe("who to greet") },
  },
  async ({ name }) => ({
    content: [{ type: "text", text: `Hello, ${name || "stranger"}!` }],
  })
);

const transport = new StdioServerTransport();
await server.connect(transport);
// stdout is the JSON-RPC channel; status lines go to stderr only.
console.error("[flint-demo] ready on stdio");
