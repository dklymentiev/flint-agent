// Plugin loader for Flint
// Scans ~/.flint/plugins/ and loads plugin modules

import { readdirSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { homedir } from "node:os";

// Read on every call, not fixed at import: FLINT_PLUGINS_DIR lets a test (or a
// bench subject) keep its plugins out of the user's ~/.flint/plugins.
function pluginsDir() {
  return process.env.FLINT_PLUGINS_DIR || join(homedir(), ".flint", "plugins");
}

// Ensure plugins directory exists
export function ensurePluginsDir() {
  const dir = pluginsDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

// Load a single plugin from its directory. `fresh` bypasses the ESM module
// cache: a reload after the file changed must run the new code, and import()
// of the same URL hands back the module it loaded the first time.
export async function loadPlugin(pluginDir, { fresh = false } = {}) {
  const manifestPath = join(pluginDir, "package.json");
  const indexPath = join(pluginDir, "index.js");

  if (!existsSync(indexPath)) return null;

  let manifest = {};
  if (existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    } catch {}
  }

  try {
    const url = pathToFileURL(indexPath).href + (fresh ? `?v=${Date.now()}-${Math.random().toString(36).slice(2)}` : "");
    const mod = await import(url);
    const plugin = mod.default || mod;

    // Validate minimum contract
    if (!plugin.name) {
      plugin.name = manifest.name || pluginDir.split(/[\\/]/).pop();
    }
    if (!plugin.type) plugin.type = "tool";
    if (!plugin.version) plugin.version = manifest.version || "0.0.0";

    return {
      name: plugin.name,
      type: plugin.type,       // "tool" | "channel" | "environment"
      version: plugin.version,
      description: plugin.description || manifest.description || "",
      tools: plugin.tools || [],
      handlers: plugin.handlers || {},
      // Channel-specific
      connect: plugin.connect || null,
      onMessage: plugin.onMessage || null,
      send: plugin.send || null,
      // Lifecycle
      init: plugin.init || null,
      destroy: plugin.destroy || null,
      // Raw module reference
      _module: plugin,
      _dir: pluginDir,
    };
  } catch (err) {
    return { name: pluginDir.split(/[\\/]/).pop(), error: err.message };
  }
}

// Load all plugins from ~/.flint/plugins/
export async function loadPlugins() {
  const dir = ensurePluginsDir();
  const loaded = [];
  const errors = [];

  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return { loaded, errors };
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const pluginDir = join(dir, entry.name);
    const plugin = await loadPlugin(pluginDir);

    if (!plugin) continue;

    if (plugin.error) {
      errors.push({ name: plugin.name, error: plugin.error });
    } else {
      loaded.push(plugin);
    }
  }

  return { loaded, errors };
}

// Get list of installed plugin names
export function listInstalledPlugins() {
  const dir = ensurePluginsDir();
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

export function getPluginsDir() {
  return pluginsDir();
}
