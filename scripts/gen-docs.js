#!/usr/bin/env node
/**
 * gen-docs.js — Extract technical reference from Flint source code.
 *
 * Outputs docs/reference.json with structured data:
 *   - tools (name, description, parameters, category, permission)
 *   - commands (name, description, args, shortcuts)
 *   - api endpoints (method, path, description, body, response)
 *   - config (env var, default, description)
 *   - profiles (name, description)
 *   - keyboard shortcuts
 *
 * Usage:
 *   node scripts/gen-docs.js              → writes docs/reference.json
 *   node scripts/gen-docs.js --markdown   → also writes docs/reference.md
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "src");

// ── Helpers ──

function readFile(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf-8");
}

function tryRead(rel) {
  try { return readFile(rel); } catch { return null; }
}

// ── 1. Extract tools from source files ──

function extractTools() {
  const tools = [];

  // Parse OpenAI function-calling tool definitions from source
  // They follow pattern: { type: "function", function: { name, description, parameters } }
  const toolFiles = [
    { file: "src/tools/filesystem.js", category: "filesystem" },
    { file: "src/tools/system.js", category: "system" },
    { file: "src/tools/screenbox.js", category: "desktop" },
    { file: "src/tools/mesh.js", category: "mesh" },
    { file: "src/tools/dataset.js", category: "dataset" },
    { file: "src/tools/tasks.js", category: "planning" },
    { file: "src/memory/tools.js", category: "memory" },
  ];

  for (const { file, category } of toolFiles) {
    const src = tryRead(file);
    if (!src) continue;

    // Split source by `type: "function"` markers, then parse each block
    const parts = src.split(/\{\s*type:\s*"function"/);
    for (let i = 1; i < parts.length; i++) {
      const block = parts[i];

      // Extract name — first `name: "xxx"` in block
      const nameMatch = block.match(/name:\s*"([^"]+)"/);
      if (!nameMatch) continue;
      const name = nameMatch[1];

      // Skip false positives (e.g. JSON.stringify bodies)
      if (name === "timer" || name === "parent-agent" || name === "api") continue;

      // Extract description — first `description: "xxx"` in block
      const descMatch = block.match(/description:\s*"((?:[^"\\]|\\.)*)"/);
      const description = descMatch ? descMatch[1].replace(/\\n/g, " ").replace(/\\"/g, '"') : "";

      // Extract parameters from properties block
      const params = [];
      const propsMatch = block.match(/properties:\s*\{([\s\S]*?)\}\s*,?\s*(?:required|\})/);
      if (propsMatch) {
        const propsBlock = propsMatch[1];
        const paramRegex = /(\w+):\s*\{\s*type:\s*"(\w+)"(?:[^}]*?description:\s*"((?:[^"\\]|\\.)*)")?/g;
        let pm;
        while ((pm = paramRegex.exec(propsBlock)) !== null) {
          // Skip "object" type (that's the parent)
          if (pm[1] === "type" || pm[2] === "object") continue;
          params.push({ name: pm[1], type: pm[2], description: (pm[3] || "").replace(/\\n/g, " ") });
        }
      }

      // Extract required params
      const reqMatch = block.match(/required:\s*\[([\s\S]*?)\]/);
      const required = reqMatch
        ? reqMatch[1].match(/"(\w+)"/g)?.map(s => s.replace(/"/g, "")) || []
        : [];

      for (const p of params) {
        p.required = required.includes(p.name);
      }

      tools.push({ name, description, category, parameters: params, source: file });
    }
  }

  return tools;
}

// ── 2. Extract permissions ──

function extractPermissions() {
  const src = tryRead("src/tools/permissions.js");
  if (!src) return {};

  const perms = {};
  const block = src.match(/DEFAULT_PERMISSIONS\s*=\s*\{([\s\S]*?)\};/);
  if (!block) return perms;

  const lineRegex = /(\w+):\s*"(allow|confirm|deny)"/g;
  let m;
  while ((m = lineRegex.exec(block[1])) !== null) {
    perms[m[1]] = m[2];
  }
  return perms;
}

// ── 3. Extract commands from commands.js ──

function extractCommands() {
  const src = tryRead("src/commands/commands.js");
  if (!src) return [];

  const commands = [];

  // Extract from /help output — most reliable source of command descriptions
  const helpRegex = /log\(chalk\.white\("  ([^"]+)"\)\s*\+\s*chalk\.gray\("([^"]+)"\)\)/g;
  let m;
  while ((m = helpRegex.exec(src)) !== null) {
    const name = m[1].trim();
    const desc = m[2].replace(/^\s*--\s*/, "").trim();
    commands.push({ name, description: desc });
  }

  // Extract keyboard shortcuts from help
  const shortcutRegex = /Shortcuts[\s\S]*?log\(chalk\.white\("  ([^"]+)"\)\s*\+\s*chalk\.gray\("  -- ([^"]+)"\)\)/g;
  // Already captured above

  return commands;
}

// ── 4. Extract keyboard shortcuts ──

function extractShortcuts() {
  // Hardcoded — keyboard shortcuts rarely change and are hard to parse from JSX
  return [
    { key: "Tab", action: "Cycle UI tabs: Chat → ToolLog → Processes → System" },
    { key: "Escape", action: "Clear input; if empty — abort current execution" },
    { key: "Up/Down", action: "Navigate input history" },
    { key: "PgUp / Left", action: "Scroll chat up (half page)" },
    { key: "PgDn / Right", action: "Scroll chat down (half page)" },
    { key: "Home", action: "Scroll to top of chat" },
    { key: "End", action: "Scroll to bottom (resume auto-scroll)" },
    { key: "Ctrl+U", action: "Clear input line" },
    { key: "Ctrl+W", action: "Delete last word" },
    { key: "Ctrl+V", action: "Paste from clipboard (supports images)" },
  ];
}

// ── 5. Extract API endpoints from server.js ──

function extractApiEndpoints() {
  const src = tryRead("src/api/server.js");
  if (!src) return [];

  const endpoints = [];
  // Match: url.pathname === "/path" && req.method === "METHOD"
  const endpointRegex = /url\.pathname\s*===\s*"([^"]+)"\s*&&\s*req\.method\s*===\s*"([^"]+)"/g;
  let m;
  while ((m = endpointRegex.exec(src)) !== null) {
    const pathname = m[1];
    const method = m[2];

    // Extract comment above — format: // POST /path -- description
    const before = src.slice(0, m.index);
    const lines = before.split("\n");
    let description = "";
    // Look at lines just above the match
    for (let j = lines.length - 1; j >= Math.max(0, lines.length - 3); j--) {
      const cm = lines[j].match(/\/\/\s*(?:POST|GET)\s+\/[\w/]+\s*--\s*(.+)/);
      if (cm) { description = cm[1].trim(); break; }
    }

    endpoints.push({ method, path: pathname, description });
  }

  return endpoints;
}

// ── 6. Extract config from config.js ──

function extractConfig() {
  const src = tryRead("src/config.js");
  if (!src) return [];

  const configs = [];
  const seen = new Set();

  // Find all process.env.XXX references
  const envRegex = /process\.env\.(\w+)/g;
  let m;
  while ((m = envRegex.exec(src)) !== null) {
    const envVar = m[1];
    if (seen.has(envVar)) continue;
    seen.add(envVar);

    // Find surrounding line for default value
    const lineStart = src.lastIndexOf("\n", m.index) + 1;
    const lineEnd = src.indexOf("\n", m.index);
    const line = src.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);

    // Try to find field name (X: ...)
    const fieldMatch = line.match(/(\w+):\s/);
    const field = fieldMatch ? fieldMatch[1] : "";

    // Try to find default value (|| "value" or || number)
    const defaultMatch = line.match(/\|\|\s*(?:"([^"]*)"|([\d.]+))/);
    const defaultVal = defaultMatch ? (defaultMatch[1] ?? defaultMatch[2]) : null;

    // Try to find description from comment
    const commentMatch = line.match(/\/\/\s*(.+)/);
    const description = commentMatch ? commentMatch[1].trim() : "";

    configs.push({ field, envVar, default: defaultVal, description });
  }

  const cliFlags = [
    { flag: "--port", envVar: "AGENT_PORT", default: "3000", description: "HTTP server port" },
    { flag: "--model", envVar: "OPENROUTER_MODEL", default: "google/gemini-2.5-flash", description: "AI model ID" },
    { flag: "--profile", description: "Load agent profile at startup" },
    { flag: "--provider", description: "LLM provider (openrouter, openai, anthropic, groq, together, ollama)" },
    { flag: "--new", description: "Start new session (don't restore previous)" },
  ];

  return { envVars: configs, cliFlags };
}

// ── 7. Extract profiles ──

function extractProfiles() {
  const configFile = tryRead("profiles/profiles.json");
  if (!configFile) return [];
  try {
    const cfg = JSON.parse(configFile);
    return Object.entries(cfg).map(([name, info]) => ({
      name,
      description: info.description || "",
      file: info.prompt || "",
      contextMode: info.contextMode || "full",
    }));
  } catch {
    return [];
  }
}

// ── 8. Module dependency graph ──

function buildModuleGraph() {
  const srcDir = path.join(ROOT, "src");
  const files = findJsFiles(srcDir);
  const graph = {};  // file → { imports: [file], exports: [name], layer, module }

  for (const filePath of files) {
    const rel = path.relative(ROOT, filePath).replace(/\\/g, "/");
    const src = fs.readFileSync(filePath, "utf-8");
    const imports = [];
    const exports = [];

    // Parse imports: import { X } from "./path.js"
    const importRegex = /import\s+(?:\{([^}]*)\}|(\w+))\s+from\s+["']([^"']+)["']/g;
    let m;
    while ((m = importRegex.exec(src)) !== null) {
      const specifier = m[3];
      // Skip node: and npm modules
      if (specifier.startsWith("node:") || !specifier.startsWith(".")) continue;

      const imported = m[1]
        ? m[1].split(",").map(s => s.trim().split(/\s+as\s+/)[0]).filter(Boolean)
        : [m[2]];

      // Resolve relative path
      const dir = path.dirname(filePath);
      const resolved = path.relative(ROOT, path.resolve(dir, specifier)).replace(/\\/g, "/");
      imports.push({ from: resolved, names: imported });
    }

    // Parse exports: export function X, export const X, export { X }
    const exportFuncRegex = /export\s+(?:async\s+)?function\s+(\w+)/g;
    while ((m = exportFuncRegex.exec(src)) !== null) exports.push(m[1]);

    const exportConstRegex = /export\s+(?:const|let|var)\s+(\w+)/g;
    while ((m = exportConstRegex.exec(src)) !== null) exports.push(m[1]);

    const exportBraceRegex = /export\s+\{([^}]+)\}/g;
    while ((m = exportBraceRegex.exec(src)) !== null) {
      const names = m[1].split(",").map(s => s.trim().split(/\s+as\s+/)[0]).filter(Boolean);
      exports.push(...names);
    }

    // Default export
    if (/export\s+default/.test(src)) exports.push("default");

    // Determine layer from path
    const layer = classifyLayer(rel);

    graph[rel] = { imports, exports, layer };
  }

  return graph;
}

function findJsFiles(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findJsFiles(full));
    } else if (entry.name.endsWith(".js")) {
      results.push(full);
    }
  }
  return results;
}

function classifyLayer(rel) {
  if (rel === "src/index.js" || rel === "src/launcher.js") return "entry";
  if (rel === "src/config.js") return "config";
  if (rel.startsWith("src/components/")) return "ui";
  if (rel.startsWith("src/store/")) return "store";
  if (rel.startsWith("src/agent/")) return "agent";
  if (rel.startsWith("src/api/")) return "api";
  if (rel.startsWith("src/tools/")) return "tools";
  if (rel.startsWith("src/commands/")) return "commands";
  if (rel.startsWith("src/memory/")) return "memory";
  if (rel.startsWith("src/tasks/")) return "tasks";
  if (rel.startsWith("src/plugins/")) return "plugins";
  if (rel.startsWith("src/security/")) return "security";
  if (rel.startsWith("src/logging/")) return "logging";
  if (rel.startsWith("src/ui/")) return "ui";
  if (rel === "src/sessions.js") return "sessions";
  if (rel === "src/profiles.js") return "profiles";
  if (rel === "src/registry.js") return "registry";
  if (rel === "src/mcp-client.js") return "mcp";
  if (rel.startsWith("src/providers/")) return "providers";
  return "other";
}

// ── 9. Build feature modules from graph ──

function buildModules(graph) {
  // Aggregate files into logical modules, compute cross-module dependencies
  const modules = {};

  for (const [file, info] of Object.entries(graph)) {
    const layer = info.layer;
    if (!modules[layer]) {
      modules[layer] = { files: [], exports: [], dependsOn: new Set(), usedBy: new Set() };
    }
    modules[layer].files.push(file);
    modules[layer].exports.push(...info.exports.map(e => ({ name: e, file })));
  }

  // Compute cross-module edges
  for (const [file, info] of Object.entries(graph)) {
    const sourceLayer = info.layer;
    for (const imp of info.imports) {
      const targetInfo = graph[imp.from];
      if (!targetInfo) continue;
      const targetLayer = targetInfo.layer;
      if (targetLayer !== sourceLayer) {
        modules[sourceLayer].dependsOn.add(targetLayer);
        if (modules[targetLayer]) modules[targetLayer].usedBy.add(sourceLayer);
      }
    }
  }

  // Convert sets to arrays for JSON
  const result = {};
  const layerLabels = {
    entry: "Entry Point",
    config: "Configuration",
    ui: "UI (React/Ink)",
    store: "State (Zustand Store)",
    agent: "Agent Core",
    api: "HTTP API",
    tools: "Tools",
    commands: "REPL Commands",
    memory: "Memory System",
    tasks: "Task Planning (SQLite)",
    plugins: "Plugin System",
    logging: "Logging",
    sessions: "Session Persistence",
    profiles: "Agent Profiles",
    registry: "Agent Registry",
    mcp: "MCP Client",
    security: "Security",
    providers: "Providers",
  };

  // Sort layers by dependency depth (entry first)
  const layerOrder = [
    "entry", "config", "store", "agent", "api", "providers", "tools", "commands",
    "ui", "memory", "tasks", "plugins", "sessions", "profiles", "registry", "mcp", "logging", "security",
  ];

  for (const layer of layerOrder) {
    const mod = modules[layer];
    if (!mod) continue;
    result[layer] = {
      label: layerLabels[layer] || layer,
      files: mod.files.sort(),
      exports: [...new Set(mod.exports.map(e => e.name))].sort(),
      dependsOn: [...mod.dependsOn].sort(),
      usedBy: [...mod.usedBy].sort(),
    };
  }

  return result;
}

// ── 10. Build detailed cross-file dependency map ──

function buildFileDepMap(graph) {
  const deps = {};
  for (const [file, info] of Object.entries(graph)) {
    const targets = info.imports.map(imp => ({
      file: imp.from,
      imports: imp.names,
      layer: graph[imp.from]?.layer || "external",
    }));
    if (targets.length) {
      deps[file] = { layer: info.layer, imports: targets };
    }
  }
  return deps;
}

// ── 11. Extract UI tabs mapping ──

function extractTabs() {
  const appSrc = tryRead("src/components/App.js");
  if (!appSrc) return [];

  // Find TABS array
  const tabsMatch = appSrc.match(/const\s+TABS\s*=\s*\[([^\]]+)\]/);
  const tabNames = tabsMatch
    ? tabsMatch[1].match(/"([^"]+)"/g)?.map(s => s.replace(/"/g, "")) || []
    : [];

  const tabs = [];
  const componentMap = {
    chat: { component: "ScrollableOutput + StreamLine", file: "src/components/ScrollableOutput.js" },
    toollog: { component: "ToolLogPanel", file: "src/components/ToolLogPanel.js" },
    processes: { component: "ProcessPanel", file: "src/components/ProcessPanel.js" },
    system: { component: "SystemPanel", file: "src/components/SystemPanel.js" },
  };

  for (const name of tabNames) {
    const info = componentMap[name] || {};
    const tab = { name, component: info.component || name, file: info.file || "" };

    // Parse what store fields the component reads
    if (info.file) {
      const src = tryRead(info.file);
      if (src) {
        const storeFields = [];
        // Match: store.getState().fieldName or () => store.getState().fieldName
        const fieldRegex = /store\.getState\(\)\.(\w+)/g;
        let m;
        while ((m = fieldRegex.exec(src)) !== null) {
          if (!storeFields.includes(m[1])) storeFields.push(m[1]);
        }
        // Match: s.fieldName inside selectors
        const selectorRegex = /\(s\)\s*=>\s*\(\{([\s\S]*?)\}\)/;
        const selMatch = src.match(selectorRegex);
        if (selMatch) {
          const fields = selMatch[1].match(/s\.(\w+)/g);
          if (fields) {
            for (const f of fields) {
              const name = f.replace("s.", "");
              if (!storeFields.includes(name)) storeFields.push(name);
            }
          }
        }
        tab.storeFields = storeFields;
      }
    }

    // For chat tab — it uses lines + streamText + processStreams
    if (name === "chat") {
      tab.storeFields = ["lines", "streamText", "processStreams"];
    }

    tabs.push(tab);
  }

  // Map tools to tabs — which tools produce data for which tab
  const toolTabMap = {
    toollog: { description: "All tool calls are logged here with name, args, result, and timestamp" },
    processes: {
      description: "Background processes started by run_background_command",
      tools: ["run_background_command", "kill_process", "list_processes", "peek_process"],
    },
    system: {
      description: "Model info, session stats, context usage, config, agent status",
      tools: ["switch_model", "check_balance", "list_models"],
    },
    chat: {
      description: "Main conversation, streaming AI responses, inline process output",
      tools: ["all tools show results here"],
    },
  };

  for (const tab of tabs) {
    const mapping = toolTabMap[tab.name];
    if (mapping) {
      tab.description = mapping.description;
      if (mapping.tools) tab.relatedTools = mapping.tools;
    }
  }

  return tabs;
}

// ── 12. Package info ──

function getPackageInfo() {
  try {
    const pkg = JSON.parse(readFile("package.json"));
    return { name: pkg.name, version: pkg.version, description: pkg.description };
  } catch {
    return { name: "flint", version: "unknown" };
  }
}

// ── Build reference ──

function buildReference() {
  const tools = extractTools();
  const permissions = extractPermissions();
  const commands = extractCommands();
  const shortcuts = extractShortcuts();
  const endpoints = extractApiEndpoints();
  const configData = extractConfig();
  const profiles = extractProfiles();
  const pkg = getPackageInfo();

  // Attach permissions to tools
  for (const tool of tools) {
    tool.permission = permissions[tool.name] || "confirm";
  }

  // Group tools by category
  const toolsByCategory = {};
  for (const tool of tools) {
    if (!toolsByCategory[tool.category]) toolsByCategory[tool.category] = [];
    toolsByCategory[tool.category].push(tool);
  }

  // Build module graph
  const graph = buildModuleGraph();
  const modules = buildModules(graph);
  const fileDeps = buildFileDepMap(graph);
  const tabs = extractTabs();

  return {
    _generated: new Date().toISOString(),
    _generator: "scripts/gen-docs.js",
    package: pkg,
    architecture: {
      modules,
      fileDependencies: fileDeps,
      fileCount: Object.keys(graph).length,
      moduleCount: Object.keys(modules).length,
    },
    tools: { all: tools, byCategory: toolsByCategory, count: tools.length },
    permissions,
    commands: { list: commands, count: commands.length },
    shortcuts,
    api: { endpoints, count: endpoints.length },
    config: configData,
    profiles,
    ui: { tabs },
  };
}

// ── Generate markdown ──

function toMarkdown(ref) {
  const lines = [];
  const h = (level, text) => lines.push(`${"#".repeat(level)} ${text}\n`);
  const p = (text) => lines.push(`${text}\n`);
  const row = (...cols) => lines.push(`| ${cols.join(" | ")} |`);

  h(1, `${ref.package.name} v${ref.package.version} — Technical Reference`);
  p(`> Auto-generated on ${ref._generated.split("T")[0]} by \`${ref._generator}\``);
  p(`> ${ref.architecture.fileCount} files, ${ref.architecture.moduleCount} modules, ${ref.tools.count} tools, ${ref.commands.count} commands, ${ref.api.count} API endpoints`);
  p("---\n");

  // Architecture
  h(2, "Architecture");
  p("Module dependency graph (A → B means A imports from B):\n");
  p("```");
  for (const [layer, mod] of Object.entries(ref.architecture.modules)) {
    const deps = mod.dependsOn.length ? ` → ${mod.dependsOn.join(", ")}` : "";
    lines.push(`  ${mod.label.padEnd(24)} [${mod.files.length} files]${deps}`);
  }
  p("```\n");

  // Module details
  for (const [layer, mod] of Object.entries(ref.architecture.modules)) {
    h(3, `${mod.label}`);
    p("Files: " + mod.files.map(f => "`" + f + "`").join(", "));
    if (mod.exports.length) {
      const shown = mod.exports.slice(0, 20).map(e => "`" + e + "`").join(", ");
      const more = mod.exports.length > 20 ? ` ... (+${mod.exports.length - 20})` : "";
      p("Exports: " + shown + more);
    }
    if (mod.dependsOn.length) p(`Depends on: ${mod.dependsOn.join(", ")}`);
    if (mod.usedBy.length) p(`Used by: ${mod.usedBy.join(", ")}`);
    p("");
  }
  p("---\n");

  // Tools by category
  h(2, "Tools");
  const categoryLabels = {
    filesystem: "Filesystem", system: "System", desktop: "Desktop (Screenbox)",
    mesh: "Mesh Memory", dataset: "Datasets", planning: "Task Planning", memory: "Memory",
  };

  for (const [cat, catTools] of Object.entries(ref.tools.byCategory)) {
    h(3, categoryLabels[cat] || cat);
    row("Tool", "Description", "Permission", "Parameters");
    row("----", "-----------", "----------", "----------");
    for (const t of catTools) {
      const params = t.parameters
        .map(p => `\`${p.name}\`${p.required ? "*" : ""}: ${p.type}`)
        .join(", ") || "—";
      const desc = t.description.split(".")[0] || "—";
      row(`\`${t.name}\``, desc, t.permission, params);
    }
    p("");
  }

  // Commands
  h(2, "Commands");
  row("Command", "Description");
  row("-------", "-----------");
  for (const c of ref.commands.list) {
    row(`\`${c.name}\``, c.description);
  }
  p("");

  // Shortcuts
  h(2, "Keyboard Shortcuts");
  row("Key", "Action");
  row("---", "------");
  for (const s of ref.shortcuts) {
    row(`**${s.key}**`, s.action);
  }
  p("");

  // UI Tabs
  if (ref.ui && ref.ui.tabs.length) {
    h(2, "UI Tabs");
    p("Switch tabs with **Tab** key.\n");
    for (const tab of ref.ui.tabs) {
      h(3, tab.name.charAt(0).toUpperCase() + tab.name.slice(1) + " Tab");
      p("Component: `" + tab.component + "` (" + (tab.file || "composite") + ")");
      if (tab.description) p(tab.description);
      if (tab.storeFields && tab.storeFields.length) {
        p("Store fields: " + tab.storeFields.map(f => "`" + f + "`").join(", "));
      }
      if (tab.relatedTools && tab.relatedTools.length) {
        p("Related tools: " + tab.relatedTools.map(t => "`" + t + "`").join(", "));
      }
      p("");
    }
  }

  // API
  h(2, "HTTP API");
  row("Method", "Path", "Description");
  row("------", "----", "-----------");
  for (const e of ref.api.endpoints) {
    row(e.method, `\`${e.path}\``, e.description);
  }
  p("");

  // Config
  h(2, "Configuration");
  h(3, "Environment Variables");
  if (ref.config.envVars) {
    row("Variable", "Field", "Default");
    row("--------", "-----", "-------");
    for (const c of ref.config.envVars) {
      row(`\`${c.envVar}\``, c.field, c.default || "—");
    }
  }
  p("");

  h(3, "CLI Flags");
  if (ref.config.cliFlags) {
    row("Flag", "Description");
    row("----", "-----------");
    for (const f of ref.config.cliFlags) {
      row(`\`${f.flag}\``, f.description || `Maps to ${f.envVar} (default: ${f.default})`);
    }
  }
  p("");

  // Profiles
  if (ref.profiles.length) {
    h(2, "Profiles");
    row("Name", "Description", "Context Mode");
    row("----", "-----------", "------------");
    for (const pr of ref.profiles) {
      row(pr.name, pr.description || "—", pr.contextMode);
    }
    p("");
  }

  // Permissions
  h(2, "Default Permissions");
  const groups = { allow: [], confirm: [], deny: [] };
  for (const [name, level] of Object.entries(ref.permissions)) {
    (groups[level] || []).push(name);
  }
  for (const [level, names] of Object.entries(groups)) {
    if (names.length) {
      p(`**${level}**: ${names.map(n => `\`${n}\``).join(", ")}`);
    }
  }

  return lines.join("\n");
}

// ── Main ──

const ref = buildReference();
const docsDir = path.join(ROOT, "docs");
if (!fs.existsSync(docsDir)) fs.mkdirSync(docsDir);

// Always write JSON
const jsonPath = path.join(docsDir, "reference.json");
fs.writeFileSync(jsonPath, JSON.stringify(ref, null, 2) + "\n");
console.log(`  reference.json: ${ref.tools.count} tools, ${ref.commands.count} commands, ${ref.api.count} endpoints`);

// Write markdown if --markdown flag
if (process.argv.includes("--markdown")) {
  const mdPath = path.join(docsDir, "reference.md");
  fs.writeFileSync(mdPath, toMarkdown(ref));
  console.log(`  reference.md: written`);
}

// Print architecture summary
const arch = ref.architecture;
console.log(`  architecture: ${arch.fileCount} files, ${arch.moduleCount} modules`);
for (const [layer, mod] of Object.entries(arch.modules)) {
  const deps = mod.dependsOn.length ? ` → ${mod.dependsOn.join(", ")}` : "";
  console.log(`    ${mod.label.padEnd(24)} [${mod.files.length}]${deps}`);
}

console.log(`  Output: ${docsDir}/`);
