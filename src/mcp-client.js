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
import { noteMcpTool } from "./tools/mcp-tool-servers.js";
import { homeStateDir } from "./data-dir.js";
const log = createLogger("mcp-client");

// Abort signal for MCP calls — set by agent loop, used by handlers
let _abortSignal = null;
export function setMcpAbortSignal(signal) { _abortSignal = signal; }
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const _flintVersion = (() => { try { return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")).version; } catch { return "?"; } })();
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { detectBase64Content, validateContentType } from "./security/content-validator.js";

// Active MCP client connections
const clients = new Map(); // name -> { client, transport, url, transportType }

/**
 * A server that cannot connect because of how it is configured: a header names
 * a secret that is not stored, a URL or command is invalid. Trying again
 * changes nothing until the operator changes the config or stores the secret.
 * Everything else that fails a connect (refused, timeout, 5xx) is treated as
 * transient.
 */
export class McpConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "McpConfigError";
    this.code = "MCP_CONFIG";
  }
}

/** Host identity reaches its MCP children; model provider keys do not. */
export function mcpChildEnv(serverEnv = {}, hostEnv = process.env) {
  const env = { ...hostEnv };
  for (const name of ["OPENROUTER_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY",
    "CLAUDE_CODE_OAUTH_TOKEN"]) delete env[name];
  // A host may give an MCP server its *own* credential explicitly in .mcp.json.
  return { ...env, ...serverEnv };
}

// Allowed MCP URL schemes — only localhost HTTP for now
const ALLOWED_SCHEMES = new Set(["http:", "https:"]);

function validateMcpUrl(url) {
  try {
    const parsed = new URL(url);
    if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
      throw new McpConfigError(`Unsupported MCP URL scheme: ${parsed.protocol} (allowed: http, https)`);
    }
    return parsed;
  } catch (err) {
    if (err instanceof McpConfigError) throw err;
    throw new McpConfigError(`Invalid MCP URL: ${url}`);
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

// The operator's own MCP file, read in the console and in headless runs
// (owner, 2026-10-03). MCP_SERVERS is name|transport|url and has nowhere to
// put a header, so a server that wants a token in `Authorization` could be
// configured only in stdio mode, where a .mcp.json is read; in the console it
// took a local bridge process whose only job was to add the header. Same
// format as .mcp.json, kept in the data folder beside provider.json.

/** <data folder>/mcp.json */
export function userMcpConfigPath(env = process.env) {
  const dir = env.FLINT_DATA_DIR ? path.resolve(env.FLINT_DATA_DIR) : homeStateDir();
  return path.join(dir, "mcp.json");
}

/**
 * The servers of MCP_SERVERS together with those of the user's MCP file, or
 * null when there is no file (the caller then keeps what it had). A server
 * named in both is taken from the file. A file that cannot be read throws
 * with its path in the message: a broken file must be said, not skipped.
 */
export function withUserMcpServers(envServers, { file = userMcpConfigPath() } = {}) {
  if (!existsSync(file)) return null;
  let fromFile;
  try {
    fromFile = mcpJsonServers(JSON.parse(readFileSync(file, "utf-8")));
  } catch (err) {
    throw new Error(`MCP config ${file} was not loaded: ${err.message}`);
  }
  const named = new Set(fromFile.map((s) => s.name));
  return [...parseServerConfig(envServers).filter((s) => !named.has(s.name)), ...fromFile];
}

/**
 * Header values with ${NAME} filled in, so a token stays out of the file.
 * A name is looked up in Flint's encrypted key store first (/mcp-secret NAME
 * puts it there) and in the environment second. One that is in neither, or
 * empty, is an error naming it and the server: sent as written, or sent
 * empty, the header would reach the server as a wrong token and come back as
 * a puzzling 401.
 */
export async function expandHeaders(headers, serverName, env = process.env) {
  const { getMcpSecret } = await import("./providers/keys.js");
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    let text = String(value);
    const names = [...new Set([...text.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((m) => m[1]))];
    for (const name of names) {
      const secret = (await getMcpSecret(name)) || env[name];
      if (!secret) {
        throw new McpConfigError(`header "${key}" of MCP server "${serverName}" names \${${name}}, which is not in the key store (/mcp-secret ${name}) and not set in the environment`);
      }
      text = text.split("${" + name + "}").join(secret);
    }
    out[key] = text;
  }
  return out;
}

/**
 * Connect to a single MCP server and return its tools + handlers.
 */
async function connectServer(serverConfig) {
  const { name, transport: transportType, url } = serverConfig;
  const requestInit = serverConfig.headers ? { headers: await expandHeaders(serverConfig.headers, name) } : undefined;

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
      throw new McpConfigError(`MCP stdio command must be an absolute path, got: "${command}"`);
    }
    // Sanitize server name to alphanumeric + underscore/dash
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      throw new McpConfigError(`MCP server name must be alphanumeric (got: "${name}")`);
    }
    // The SDK's default hands the server a minimal environment. A server from
    // a .mcp.json gets host identity and its own env, without silently
    // inheriting the model's API key.
    const env = serverConfig.fromFile ? mcpChildEnv(serverConfig.env || {}) : undefined;
    transport = new StdioClientTransport({ command, args, ...(env ? { env } : {}) });
  } else if (transportType === "sse") {
    const parsedUrl = validateMcpUrl(url);
    transport = new SSEClientTransport(parsedUrl, requestInit ? { requestInit } : undefined);
  } else if (transportType === "http") {
    const parsedUrl = validateMcpUrl(url);
    transport = new StreamableHTTPClientTransport(parsedUrl, requestInit ? { requestInit } : undefined);
  } else {
    throw new McpConfigError(`Unsupported MCP transport: ${transportType} (supported: "sse", "http", "stdio")`);
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
    noteMcpTool(toolName, name);

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
      retryState.delete(config.name);
      results.push({ name: config.name, tools: result.toolCount, ok: true });
    } catch (err) {
      await noteFailure(config, err, Date.now());
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
 * Reconnect state, the one place it lives. Per server that is not connected:
 *   { fatal, sig, failures, nextAt, error }
 * fatal: the failure is a configuration one; no retry until `sig` (the config
 * plus whether each ${SECRET} it names is available) differs from now.
 * failures/nextAt: transient failures so far and the earliest next attempt.
 * A successful connect, by any path, deletes the entry.
 */
const retryState = new Map();

export const RECONNECT_BASE_MS = 60_000;
export const RECONNECT_MAX_MS = 600_000;

/** Delay before the next attempt after the nth transient failure (1-based). */
export function backoffDelayMs(failures) {
  return Math.min(RECONNECT_BASE_MS * 2 ** Math.max(0, failures - 1), RECONNECT_MAX_MS);
}

/** What a retry depends on: the server's config and which of its secrets resolve. */
async function configSignature(cfg, env = process.env) {
  const { getMcpSecret } = await import("./providers/keys.js");
  const names = new Set();
  for (const value of Object.values(cfg.headers || {})) {
    for (const m of String(value).matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) names.add(m[1]);
  }
  const have = [];
  for (const n of [...names].sort()) have.push(`${n}=${(await getMcpSecret(n)) || env[n] ? 1 : 0}`);
  return JSON.stringify(cfg) + "|" + have.join(",");
}

async function noteFailure(cfg, err, now) {
  const prev = retryState.get(cfg.name);
  if (err instanceof McpConfigError) {
    retryState.set(cfg.name, { fatal: true, sig: await configSignature(cfg), failures: 0, nextAt: Infinity, error: err.message });
    return { kind: "config", error: err.message };
  }
  const failures = (prev && !prev.fatal ? prev.failures : 0) + 1;
  const delayMs = backoffDelayMs(failures);
  retryState.set(cfg.name, { fatal: false, failures, nextAt: now + delayMs, error: err.message });
  return { kind: "transient", error: err.message, delayMs };
}

/**
 * Reconnect a single MCP server by name (re-reads config from env). This is
 * also the manual path: a success clears any fatal or backoff state, so the
 * auto-reconnect covers the server again; a failure is recorded like any other.
 */
export async function reconnectServer(name, serversEnv) {
  await disconnectServer(name);
  const configs = parseServerConfig(serversEnv);
  const cfg = configs.find((c) => c.name === name);
  if (!cfg) throw new McpConfigError(`Server "${name}" not found in MCP_SERVERS config`);
  try {
    const result = await connectServer(cfg);
    retryState.delete(name);
    return result;
  } catch (err) {
    await noteFailure(cfg, err, Date.now());
    throw err;
  }
}

/** Test and diagnostics view of the reconnect state. */
export function getReconnectState(name) {
  return retryState.get(name);
}

export function resetReconnectState() {
  retryState.clear();
}

/**
 * One pass of the health check: try every configured server that is down and
 * is due. Returns events for the caller to show:
 *   { type: "attempt" | "connected" | "fatal" | "backoff", name, ... }
 * "fatal" is reported once per failing config, never again until the config
 * or a secret it names changes. "backoff".delayMs is the delay actually
 * applied: the server is not tried again before that much time has passed.
 * `connect` is injectable for tests.
 */
export async function autoReconnectTick(serversEnv, { now = Date.now(), connect = connectServer, env = process.env } = {}) {
  const events = [];
  for (const cfg of parseServerConfig(serversEnv)) {
    if (clients.has(cfg.name)) { retryState.delete(cfg.name); continue; }
    const st = retryState.get(cfg.name);
    if (st?.fatal) {
      if (st.sig === await configSignature(cfg, env)) continue;
      retryState.delete(cfg.name); // config or secret changed: a fresh start
    } else if (st && now < st.nextAt) {
      continue;
    }
    events.push({ type: "attempt", name: cfg.name });
    try {
      const result = await connect(cfg);
      retryState.delete(cfg.name);
      events.push({ type: "connected", name: cfg.name, result });
    } catch (err) {
      const f = await noteFailure(cfg, err, now);
      events.push(f.kind === "config"
        ? { type: "fatal", name: cfg.name, error: f.error }
        : { type: "backoff", name: cfg.name, error: f.error, delayMs: f.delayMs });
    }
  }
  return events;
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
