// install_plugin and reload_plugins: the agent extends itself from the
// conversation, and what it adds is usable in the same turn.
//
// WHY: plugins were read once at boot, and /install ended with "Restart to
// activate". So when a task needed a capability Flint lacked, the model could
// not add one: it could write a plugin or name a package, but the tool would
// only exist after a restart nobody was going to do mid-task. In the bench it
// instead spent up to 24 calls improvising around the gap.
//
// A plugin is code with the agent's own rights (files, commands, network).
// Both tools are "confirm" in the default permissions, and a plugin may not
// take a tool name that is already registered (see registerPlugin).

import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadPlugin, listInstalledPlugins, getPluginsDir } from "../plugins/loader.js";
import { installPlugin } from "../plugins/manager.js";
import { registerPlugin, unregisterPlugin, getLoadedPlugins } from "./registry.js";
import { markLoaded } from "./tool-search.js";

// What a plugin's init() receives; bootstrap fills it with config and store.
let pluginContext = {};
export function setPluginContext(ctx) {
  pluginContext = ctx || {};
}

/**
 * (Re)load one plugin folder: take out what it registered before, import it
 * fresh, init, register, and put its tools in hand.
 * @returns {Promise<{dir, name?, tools?: string[], error?: string}>}
 */
export async function activatePlugin(dir) {
  const old = unregisterPlugin(dir);
  if (old?.destroy) {
    try { await old.destroy(); } catch {}
  }
  const p = await loadPlugin(dir, { fresh: true });
  if (!p) return { dir, error: "no index.js" };
  if (p.error) return { dir, name: p.name, error: p.error };
  try {
    if (p.init) await p.init(pluginContext);
    registerPlugin(p);
  } catch (err) {
    return { dir, name: p.name, error: err.message };
  }
  const tools = (p.tools || []).map((t) => t.function?.name).filter(Boolean);
  markLoaded(tools);
  return { dir, name: p.name, tools };
}

function describe(results) {
  const lines = results.map((r) =>
    r.error
      ? `- ${r.name || r.dir}: NOT loaded: ${r.error}`
      : `- ${r.name}: ${r.tools.length ? `tools available now: ${r.tools.join(", ")}` : "loaded, no tools"}`);
  return lines.join("\n");
}

export const tools = [
  {
    type: "function",
    function: {
      name: "install_plugin",
      description:
        "Install a Flint plugin and load it at once, so its tools can be called in this same turn. " +
        "`source` is a local folder holding the plugin's index.js, or an npm package name " +
        "(installed as flint-plugin-<name>). A plugin runs with your full rights.",
      parameters: {
        type: "object",
        properties: {
          source: { type: "string", description: "Local plugin folder, or npm package name" },
        },
        required: ["source"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "reload_plugins",
      description:
        "Re-read the plugins folder and load every plugin in it fresh, including ones you just wrote or changed. " +
        "Their tools are callable in this same turn. A plugin is a folder <plugins dir>/<name>/ with an index.js " +
        "whose default export is { name, tools: [OpenAI-style function definitions], handlers: { toolName: async (args) => string } }. " +
        "The result names the plugins folder.",
      parameters: { type: "object", properties: {} },
    },
  },
];

export const handlers = {
  async install_plugin({ source }) {
    const res = await installPlugin(String(source || "").trim());
    if (!res.ok) return `Error: ${res.error}`;
    const r = await activatePlugin(res.path);
    if (r.error) {
      // Installed but unusable: taken out again, so the next boot does not
      // trip over it and the folder does not pretend to be a working plugin.
      try { rmSync(res.path, { recursive: true, force: true }); } catch {}
      return `Error: installed ${res.name} but could not load it, removed again: ${r.error}`;
    }
    return `Installed and loaded:\n${describe([r])}`;
  },

  async reload_plugins() {
    const root = getPluginsDir();
    const dirs = listInstalledPlugins().map((d) => join(root, d));
    // A plugin whose folder is gone is taken out, not left registered.
    for (const p of getLoadedPlugins().slice()) {
      if (p.dir && !dirs.includes(p.dir) && !existsSync(p.dir)) {
        const old = unregisterPlugin(p.dir);
        if (old?.destroy) { try { await old.destroy(); } catch {} }
      }
    }
    const results = [];
    for (const dir of dirs) {
      if (!existsSync(join(dir, "index.js"))) continue;
      results.push(await activatePlugin(dir));
    }
    if (!results.length) return `No plugins in ${root}.`;
    return `Plugins folder: ${root}\n${describe(results)}`;
  },
};
