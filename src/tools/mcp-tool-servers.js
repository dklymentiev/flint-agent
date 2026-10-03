// Which MCP server a tool came from.
//
// A tool is named mcp_<server>_<tool>, and both halves may contain
// underscores, so the name cannot be split back: server "a" with a tool "b_y"
// and server "a_b" with a tool "y" would both be mcp_a_b_y. The MCP client
// knows the answer at the moment it registers the tool and writes it here;
// permissions.js reads it to offer one approval for a whole server.
//
// A module of its own, with no imports, so that permissions.js does not have
// to load the MCP SDK to ask the question.

/** @type {Map<string, string>} */
const serverOfTool = new Map();

export function noteMcpTool(toolName, server) {
  serverOfTool.set(toolName, server);
}

/** The server the tool was registered by, or null for a tool that is not an MCP tool. */
export function mcpServerOf(toolName) {
  return serverOfTool.get(toolName) || null;
}
