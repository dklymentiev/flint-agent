// Red-test + verification for the demo MCP config:
// 1) connect through Flint's own production client (src/mcp-client.js)
// 2) list what the in-process registry would report (getServerStatus)
// 3) call both demo tools end-to-end through the registered handlers
import { connectMcpServers, disconnectAll, getServerStatus } from "../src/mcp-client.js";

const envStr = "demo|stdio|C:\\PROGRA~1\\nodejs\\node.exe C:\\Projects\\AI-play\\flint-agent\\scripts\\demo-mcp-server.mjs";
console.log("config string:", envStr);

const { results, tools, handlers } = await connectMcpServers(envStr);
console.log("connect results:", JSON.stringify(results, null, 2));
console.log("tools discovered:", tools.map((t) => t.function.name));

for (const s of getServerStatus(envStr)) console.log("status:", JSON.stringify(s));

const ping = await handlers.mcp_demo_ping?.({});
console.log("ping ->", ping);
const greet = await handlers.mcp_demo_greet?.({ name: "operator" });
console.log("greet ->", greet);

await disconnectAll();
console.log("OK — demo MCP server configured and callable through Flint's client");
