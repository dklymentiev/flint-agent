import { tools as fsTools, handlers as fsHandlers } from "./filesystem.js";
import { createSystemTools } from "./system.js";
import { tools as memTools, handlers as memHandlers } from "../memory/tools.js";
// screenbox.js removed — desktop tools come only via MCP
import { createLogger } from "../logging/logger.js";
import { TOOL_SEARCH_NAME, toolSearchDef, createToolSearchHandler, resetLoadedTools } from "./tool-search.js";
import { swapToolDefs, createSwapHandlers } from "./swap-tools.js";
import { swapEnabled, getCurrentSwapStore } from "../agent/swap.js";
import { tools as pluginTools, handlers as pluginHandlers } from "./plugin-tools.js";

const log = createLogger("registry");

let allTools = [];
let handlerMap = {};
let mcpStatusList = [];
let mcpGetServerStatusFn = null;
let mcpDisconnectFn = null;
let mcpReconnectFn = null;

export function initRegistry(store) {
  const { tools: sysTools, handlers: sysHandlers } = createSystemTools(store);

  handlerMap = { ...fsHandlers, ...sysHandlers, ...memHandlers, ...pluginHandlers };
  allTools = [...fsTools, ...sysTools, ...memTools, ...pluginTools];
  loadedPlugins = [];
  pluginToolOwner = new Map();

  // tool_search is always registered: with the classifier off, MCP tools past
  // the inline limit are offered through it (intent.js fallbackManifest), and
  // FLINT_TOOL_MODE=search uses it for everything outside the core set. The
  // handler searches allTools live, so MCP tools registered later are found.
  resetLoadedTools();
  handlerMap[TOOL_SEARCH_NAME] = createToolSearchHandler(() => allTools);
  allTools.push(toolSearchDef);

  // Context swap (docs/context-swap.md): reading back what the loop moved out
  // of the context. Not offered when swap is off, so FLINT_SWAP=0 leaves the
  // tool list as it was.
  if (swapEnabled()) {
    Object.assign(handlerMap, createSwapHandlers(getCurrentSwapStore));
    allTools.push(...swapToolDefs);
  }
}

// Called after async MCP init
export function registerMcpTools(tools, handlers, status) {
  Object.assign(handlerMap, handlers);
  allTools.push(...tools);
  mcpStatusList = status;
}

// Mesh tools registration
export function registerMeshTools(tools, handlers) {
  Object.assign(handlerMap, handlers);
  allTools.push(...tools);
}

// Task planning tools registration
export function registerTaskTools(tools, handlers) {
  Object.assign(handlerMap, handlers);
  allTools.push(...tools);
}

// Dataset tools registration
export function registerDatasetTools(tools, handlers) {
  Object.assign(handlerMap, handlers);
  allTools.push(...tools);
}

// Schedule / reminder tools registration
export function registerScheduleTools(tools, handlers) {
  Object.assign(handlerMap, handlers);
  allTools.push(...tools);
}

// Inbox tools registration
export function registerInboxTools(tools, handlers) {
  Object.assign(handlerMap, handlers);
  allTools.push(...tools);
}

// Plugin tools registration
let loadedPlugins = [];
// tool name -> the plugin folder that registered it, so a reload can take a
// plugin's tools out again and a name clash can be told from a re-register.
let pluginToolOwner = new Map();

/**
 * Register a loaded plugin. Throws when one of its tool names is already
 * taken by a built-in, an MCP tool or another plugin.
 *
 * WHY the refusal: handlers used to be Object.assign'ed over the map,
 * so a plugin with a tool named read_file silently replaced the real one.
 * While only the user installed plugins that was a foot-gun; now the model can
 * install one from the conversation, and the plugin is code nobody reviewed.
 */
export function registerPlugin(plugin) {
  const key = plugin._dir || plugin.name;
  const names = (plugin.tools || []).map((t) => t.function?.name).filter(Boolean);
  const taken = names.filter((n) => (handlerMap[n] || allTools.some((t) => t.function?.name === n)) && pluginToolOwner.get(n) !== key);
  if (taken.length) {
    throw new Error(`tool name already taken: ${taken.join(", ")}`);
  }
  if (plugin.tools && plugin.tools.length) {
    allTools.push(...plugin.tools);
  }
  if (plugin.handlers) {
    Object.assign(handlerMap, plugin.handlers);
  }
  for (const n of names) pluginToolOwner.set(n, key);
  loadedPlugins.push({
    name: plugin.name,
    type: plugin.type,
    version: plugin.version,
    description: plugin.description,
    toolCount: names.length,
    tools: names,
    dir: plugin._dir || null,
    destroy: plugin.destroy || null,
  });
}

/**
 * Take a plugin's tools and handlers out again, found by its folder.
 * @returns {object|null} the record that was removed (its `destroy` included)
 */
export function unregisterPlugin(dir) {
  const rec = loadedPlugins.find((p) => p.dir === dir);
  if (!rec) return null;
  const names = new Set(rec.tools);
  allTools = allTools.filter((t) => !names.has(t.function?.name));
  for (const n of names) {
    delete handlerMap[n];
    pluginToolOwner.delete(n);
  }
  loadedPlugins = loadedPlugins.filter((p) => p !== rec);
  return rec;
}

export function getLoadedPlugins() {
  return loadedPlugins;
}

// MCP management functions
export function setMcpManagement(fns) {
  mcpGetServerStatusFn = fns.getServerStatus;
  mcpDisconnectFn = fns.disconnect;
  mcpReconnectFn = fns.reconnect;
}

export function getMcpStatus() {
  return mcpStatusList;
}

export function getMcpServerStatus() {
  return mcpGetServerStatusFn ? mcpGetServerStatusFn() : [];
}

export async function mcpDisconnect(name) {
  if (!mcpDisconnectFn) return false;
  const ok = await mcpDisconnectFn(name);
  if (ok) {
    mcpStatusList = mcpStatusList.map((s) =>
      s.name === name ? { ...s, ok: false, error: "disconnected" } : s,
    );
  }
  return ok;
}

export async function mcpReconnect(name) {
  if (!mcpReconnectFn) throw new Error("MCP not configured");
  const result = await mcpReconnectFn(name);
  Object.assign(handlerMap, result.handlers);
  mcpStatusList = mcpStatusList.map((s) =>
    s.name === name ? { name, tools: result.toolCount, ok: true } : s,
  );
  for (const tool of result.tools) {
    if (!allTools.find((t) => t.function.name === tool.function.name)) {
      allTools.push(tool);
    }
  }
  return result;
}

export function getDefinitions() {
  // FLINT_TOOL_ALLOWLIST: comma-separated tool names. When set, the agent sees
  // ONLY these tools -- least-privilege mode for embedded/headless executors
  // (e.g. a host that runs Flint with just its delivery plugin: a full
  // toolset let the executor shell around the host and chase stale tasks).
  const allow = (process.env.FLINT_TOOL_ALLOWLIST || "").trim();
  if (allow) {
    const names = new Set(allow.split(",").map((x) => x.trim()).filter(Boolean));
    return allTools.filter((t) => names.has(t.function?.name));
  }
  return allTools;
}

// ── Schema Validation ────────────────────────────────────────

function validateArgs(name, args) {
  const def = allTools.find((t) => t.function?.name === name);
  if (!def?.function?.parameters) return null; // no schema = skip
  const schema = def.function.parameters;
  const errors = [];

  // Check required fields
  if (schema.required) {
    for (const field of schema.required) {
      if (args[field] === undefined || args[field] === null) {
        errors.push(`missing required parameter: "${field}"`);
      }
    }
  }

  // Type-check each provided property
  if (schema.properties) {
    for (const [key, value] of Object.entries(args)) {
      const prop = schema.properties[key];
      if (!prop) continue; // unknown props are tolerated (LLMs add extra fields)
      const expected = prop.type;
      if (!expected) continue;
      const actual = typeof value;
      if (expected === "string" && actual !== "string") {
        errors.push(`"${key}" must be string, got ${actual}`);
      } else if (expected === "integer" && (!Number.isInteger(value))) {
        errors.push(`"${key}" must be integer, got ${actual} (${value})`);
      } else if (expected === "number" && actual !== "number") {
        errors.push(`"${key}" must be number, got ${actual}`);
      } else if (expected === "boolean" && actual !== "boolean") {
        errors.push(`"${key}" must be boolean, got ${actual}`);
      } else if (expected === "array" && !Array.isArray(value)) {
        errors.push(`"${key}" must be array, got ${actual}`);
      } else if (expected === "object" && (actual !== "object" || Array.isArray(value) || value === null)) {
        errors.push(`"${key}" must be object, got ${actual}`);
      }
    }
  }

  return errors.length ? errors : null;
}

// Levenshtein distance — small helper for tool-name auto-repair.
function _levDistance(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev : Math.min(prev, dp[j], dp[j - 1]) + 1;
      prev = tmp;
    }
  }
  return dp[n];
}

// Fuzzy-match a tool name against the registry. Returns the closest registered
// name if a unique match exists within maxDistance, else null.
function _repairToolName(name, maxDistance = 2) {
  const candidates = Object.keys(handlerMap);
  if (candidates.includes(name)) return name;
  const scored = candidates
    .map((c) => ({ name: c, dist: _levDistance(name, c) }))
    .filter((x) => x.dist <= maxDistance)
    .sort((a, b) => a.dist - b.dist);
  if (scored.length === 0) return null;
  // Require unambiguous match: best is strictly closer than second-best.
  if (scored.length === 1 || scored[0].dist < scored[1].dist) return scored[0].name;
  return null;
}

export async function executeTool(name, args) {
  let handler = handlerMap[name];
  let repairedName = null;
  if (!handler) {
    const repaired = _repairToolName(name);
    if (repaired) {
      repairedName = repaired;
      handler = handlerMap[repaired];
    }
  }
  if (!handler) {
    return `Error: unknown tool "${name}"`;
  }
  if (repairedName) {
    // Log the repair so we can measure frequency; caller is agent.js which logs tool calls.
    console.error(`[tool-repair] '${name}' -> '${repairedName}'`);
    name = repairedName;
  }

  // Validate args against tool schema
  const validationErrors = validateArgs(name, args);
  if (validationErrors) {
    return `Error: invalid parameters for "${name}": ${validationErrors.join("; ")}`;
  }

  try {
    return await handler(args);
  } catch (err) {
    return `Error: ${err.message}`;
  }
}
