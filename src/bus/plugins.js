// Channel plugin loader
// Scans plugins/ directory for channel plugins.
// Each plugin: { name, priority, start(bus), stop() }

import { createLogger } from "../logging/logger.js";
import { readdirSync } from "node:fs";
import path from "node:path";
import { config } from "../config.js";

const log = createLogger("bus-plugins");

const _plugins = new Map(); // name → plugin instance

/**
 * Load and start all channel plugins from plugins/ directory.
 * @param {object} bus - bus module (push, drain, etc.)
 */
export async function loadPlugins(bus) {
  const pluginsDir = path.join(config.projectRoot, "plugins");
  let files;
  try {
    files = readdirSync(pluginsDir).filter(f => f.endsWith(".js"));
  } catch {
    // No plugins directory — that's fine
    return;
  }

  for (const file of files) {
    try {
      const mod = await import(path.join(pluginsDir, file));
      const plugin = mod.default || mod;
      if (!plugin.name || !plugin.start) {
        log.warn(`Plugin ${file} missing name or start(), skipping`);
        continue;
      }
      await plugin.start(bus);
      _plugins.set(plugin.name, plugin);
      log.info(`Plugin loaded: ${plugin.name}`, { file, priority: plugin.priority });
    } catch (err) {
      log.error(`Failed to load plugin ${file}: ${err.message}`);
    }
  }
}

/**
 * Stop all loaded plugins.
 */
export async function stopPlugins() {
  for (const [name, plugin] of _plugins) {
    try {
      if (plugin.stop) await plugin.stop();
      log.debug(`Plugin stopped: ${name}`);
    } catch (err) {
      log.error(`Failed to stop plugin ${name}: ${err.message}`);
    }
  }
  _plugins.clear();
}

/**
 * Get list of loaded plugin names.
 */
export function listPlugins() {
  return [..._plugins.keys()];
}
