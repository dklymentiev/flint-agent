/**
 * MCP client -- connects to MCP servers, discovers tools, and creates
 * OpenAI-compatible tool definitions + handler functions.
 *
 * Config via MCP_SERVERS env var:
 *   MCP_SERVERS=name1|transport|url,name2|transport|url
 *   transport: "sse" (legacy), "http" (Streamable HTTP), or "stdio" (subprocess)
 *   Examples: screenbox|sse|http://localhost:8080/sse
 *             memory|stdio|~/agent-memory/agent-memory mcp
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createLogger } from "./logging/logger.js";
import { resolveContent } from "./agent/content-resolver.js";
const log = createLogger("mcp-client");

// Abort signal for MCP calls — set by agent loop, used by handlers
let _abortSignal = null;
export function setMcpAbortSignal(signal) { _abortSignal = signal; }
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const _flintVersion = (() => { try { return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")).version; } catch { return "?"; } })();
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { detectBase64Content, validateContentType } from "./security/content-validator.js";

// Active MCP client connections
const clients = new Map(); // name -> { client, transport, url, transportType }

// Allowed MCP URL schemes — only localhost HTTP for now
const ALLOWED_SCHEMES = new Set(["http:", "https:"]);

function validateMcpUrl(url) {
  try {
    const parsed = new URL(url);
    if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
      throw new Error(`Unsupported MCP URL scheme: ${parsed.protocol} (allowed: http, https)`);
    }
    return parsed;
  } catch (err) {
    if (err.message.includes("Unsupported MCP URL")) throw err;
    throw new Error(`Invalid MCP URL: ${url}`);
  }
}

/**
 * Parse MCP_SERVERS env string into server configs.
 * Format: "name|transport|url,name2|transport|url2"
 *
 * Also takes an array of configs already parsed, as mcpJsonServers returns
 * them from a Claude-style .mcp.json.
 */
export function parseServerConfig(envStr) {
  if (!envStr) return [];
  if (Array.isArray(envStr)) return envStr.filter((s) => s && s.name);
  return envStr.split(",").map((entry) => {
    const [name, transport, ...urlParts] = entry.trim().split("|");
    return { name: name.trim(), transport: transport.trim(), url: urlParts.join("|").trim() };
  }).filter((s) => s.name && s.url);
}

/**
 * Server configs from a .mcp.json (the common mcpServers format), the file a host
 * may give every agent ({"mcpServers": {name: {type, url, headers} or
 * {command, args, env}}}). The file is the operator's own configuration, so
 * a stdio command may be a bare name found on PATH.
 */
export function mcpJsonServers(json) {
  const servers = json?.mcpServers || {};
  return Object.entries(servers).map(([name, s]) => {
    const transport = s.type || (s.command ? "stdio" : "http");
    if (transport === "stdio") {
      const args = Array.isArray(s.args) ? s.args.map(String) : [];
      return { name, transport, command: s.command, args, env: s.env || null, url: [s.command, ...args].join(" "), fromFile: true };
    }
    return { name, transport, url: s.url, headers: s.headers || null, fromFile: true };
  }).filter((s) => s.name && (s.url || s.command));
}

/**
 * Connect to a single MCP server and return its tools + handlers.
 */
async function connectServer(serverConfig) {
  const { name, transport: transportType, url } = serverConfig;
  const requestInit = serverConfig.headers ? { headers: serverConfig.headers } : undefined;

  let transport;
  if (transportType === "stdio") {
    const parts = url.split(/\s+/);
    const command = serverConfig.command || parts[0];
    const args = serverConfig.command ? (serverConfig.args || []) : parts.slice(1);
    // SEC-01: Validate stdio command is an absolute path to prevent command
    // injection. A .mcp.json is the operator's own file and may name a
    // command on PATH.
    const isAbsolute = command.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(command) || command.startsWith("~");
    if (!isAbsolute && !serverConfig.fromFile) {
      throw new Error(`MCP stdio command must be an absolute path, got: "${command}"`);
    }
    // Sanitize server name to alphanumeric + underscore/dash
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      throw new Error(`MCP server name must be alphanumeric (got: "${name}")`);
    }
    // The SDK's default hands the server a minimal environment. A server from
    // a .mcp.json gets ours plus its own env (a host's
    // servers may read their agent's identity from it).
    const env = serverConfig.fromFile ? { ...process.env, ...(serverConfig.env || {}) } : undefined;
    transport = new StdioClientTransport({ command, args, ...(env ? { env } : {}) });
  } else if (transportType === "sse") {
    const parsedUrl = validateMcpUrl(url);
    transport = new SSEClientTransport(parsedUrl, requestInit ? { requestInit } : undefined);
  } else if (transportType === "http") {
    const parsedUrl = validateMcpUrl(url);
    transport = new StreamableHTTPClientTransport(parsedUrl, requestInit ? { requestInit } : undefined);
  } else {
    throw new Error(`Unsupported MCP transport: ${transportType} (supported: "sse", "http", "stdio")`);
  }

  const client = new Client(
    { name: "flint", version: _flintVersion },
    { capabilities: {} },
  );

  await client.connect(transport);

  // Discover tools
  const { tools: mcpTools } = await client.listTools();

  clients.set(name, { client, transport, url, transportType, command: transportType === "stdio" ? url : undefined });

  // Convert MCP tools -> OpenAI function calling format + handlers
  const tools = [];
  const handlers = {};

  for (const tool of mcpTools) {
    const toolName = `mcp_${name}_${tool.name}`;

    // OpenAI function calling format — prefixed to avoid collisions
    tools.push({
      type: "function",
      function: {
        name: toolName,
        description: tool.description || "",
        parameters: tool.inputSchema || { type: "object", properties: {} },
      },
    });

    // Handler that proxies to MCP server (use original name for callTool)
    const originalName = tool.name;
    handlers[toolName] = async (args) => {
      // Timeout wrapper: MCP calls must complete within 60s
      const MCP_TIMEOUT = 60000;
      const timeoutController = new AbortController();
      const timer = setTimeout(() => timeoutController.abort(), MCP_TIMEOUT);
      // Combine agent abort signal with timeout
      const combinedSignal = _abortSignal
        ? AbortSignal.any([_abortSignal, timeoutController.signal])
        : timeoutController.signal;
      let result;
      try {
        result = await client.callTool(
          { name: originalName, arguments: args },
          undefined,
          { signal: combinedSignal }
        );
      } catch (err) {
        clearTimeout(timer);
        if (timeoutController.signal.aborted && !_abortSignal?.aborted) {
          log.warn("mcp-tool-timeout", { tool: toolName, timeout: MCP_TIMEOUT });
          return `Error: MCP tool call timed out after ${MCP_TIMEOUT / 1000}s. The MCP server may be unresponsive. Try again.`;
        }
        throw err;
      }
      clearTimeout(timer);

      // Debug: log raw MCP content block types for diagnostics
      if (result.content?.length) {
        const blockTypes = result.content.map(b => `${b.type}${b.mimeType ? `(${b.mimeType})` : ""}${b.data ? `[${b.data.length}b]` : ""}`);
        log.debug("mcp-result-blocks", { tool: toolName, blocks: blockTypes });
      }

      if (result.isError) {
        const errText = result.content
          ?.map((c) => c.text || "")
          .filter(Boolean)
          .join("\n") || "MCP tool error";
        return `Error: ${errText}`;
      }

      // Resolve content type from raw MCP blocks — no hardcoded type checks
      const resolved = resolveContent(result.content);

      // Security: validate binary data
      if (resolved.data) {
        const { isBinary, detected } = detectBase64Content(resolved.data);
        if (isBinary && detected?.type === "executable") {
          return `[Security: MCP server returned executable disguised as ${resolved.type} — blocked]`;
        }
      }

      // Media types (image, audio, video) → _image format for agent.js perception
      if (["image", "audio", "video"].includes(resolved.type)) {
        const format = (resolved.mimeType || "application/octet-stream").split("/")[1] || "bin";
        return {
          _image: true, // generic flag for "needs perception" — not just images
          data: resolved.data,
          format,
          meta: `mcp:${toolName}`,
          text: resolved.text || undefined,
          mediaType: resolved.type,
        };
      }

      // Mixed content with media → extract media, attach text
      if (resolved.type === "mixed" && resolved.parts) {
        const mediaPart = resolved.parts.find(p => ["image", "audio", "video"].includes(p.type));
        if (mediaPart) {
          const textParts = resolved.parts.filter(p => p.type === "text").map(p => p.text).filter(Boolean);
          const format = (mediaPart.mimeType || "application/octet-stream").split("/")[1] || "bin";
          return {
            _image: true,
            data: mediaPart.data,
            format,
            meta: `mcp:${toolName}`,
            text: textParts.join("\n") || undefined,
            mediaType: mediaPart.type,
          };
        }
      }

      // Text/document/binary — return as string (strip binary data from fallback)
      if (resolved.text) return resolved.text;
      const { data: _data, ...safeResolved } = resolved;
      return JSON.stringify(safeResolved) || "OK";
    };
  }

  return { tools, handlers, serverName: name, toolCount: mcpTools.length };
}

/**
 * Connect to all configured MCP servers and return combined tools + handlers.
 */
export async function connectMcpServers(serversEnv) {
  const configs = parseServerConfig(serversEnv);
  if (!configs.length) return { tools: [], handlers: {} };

  const allTools = [];
  const allHandlers = {};
  const results = [];

  for (const config of configs) {
    try {
      const result = await connectServer(config);
      allTools.push(...result.tools);
      Object.assign(allHandlers, result.handlers);
      results.push({ name: config.name, tools: result.toolCount, ok: true });
    } catch (err) {
      results.push({ name: config.name, tools: 0, ok: false, error: err.message });
    }
  }

  return { tools: allTools, handlers: allHandlers, results };
}

/**
 * Disconnect all MCP clients.
 */
export async function disconnectAll() {
  for (const [name, { client }] of clients) {
    try {
      await client.close();
    } catch {}
  }
  clients.clear();
}

/**
 * Disconnect a single MCP server by name.
 */
export async function disconnectServer(name) {
  const entry = clients.get(name);
  if (!entry) return false;
  try {
    await entry.client.close();
  } catch {}
  clients.delete(name);
  return true;
}

/**
 * Reconnect a single MCP server by name (re-reads config from env).
 */
export async function reconnectServer(name, serversEnv) {
  // Disconnect if already connected
  await disconnectServer(name);
  const configs = parseServerConfig(serversEnv);
  const cfg = configs.find((c) => c.name === name);
  if (!cfg) throw new Error(`Server "${name}" not found in MCP_SERVERS config`);
  return connectServer(cfg);
}

/**
 * Get list of configured server names (from env) and their connection status.
 */
export function getServerStatus(serversEnv) {
  const configs = parseServerConfig(serversEnv);
  return configs.map((cfg) => ({
    name: cfg.name,
    url: cfg.url,
    transport: cfg.transport,
    connected: clients.has(cfg.name),
  }));
}
