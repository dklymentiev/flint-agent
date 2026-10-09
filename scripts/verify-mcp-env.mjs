// Same path Flint uses at boot: src/config.js does `import "dotenv/config"`
// from the project root, so MCP_SERVERS comes from ./.env. This script
// reproduces that: load dotenv from CWD, then connect whatever config
// declares, and print the resulting server status — without ever printing
// the .env values themselves.
import "dotenv/config";
import { connectMcpServers, getServerStatus, disconnectAll } from "../src/mcp-client.js";

const declared = process.env.MCP_SERVERS;
if (!declared) {
  console.log("MCP_SERVERS: (not set) — .env not read");
  process.exit(1);
}
console.log("MCP_SERVERS set, server names:", declared.split(",").map((s) => s.split("|")[0]).join(", "));

const { results, tools } = await connectMcpServers(declared);
console.log("connect results:", JSON.stringify(results, null, 2));
console.log("tools available:", tools.map((t) => t.function.name));
for (const s of getServerStatus(declared)) {
  console.log(`list_mcp_servers would show: ${s.connected ? "[+]" : "[ ]"} ${s.name}  ${s.url}`);
}
await disconnectAll();
process.exit(0);
