// Integration tests: Plugin system lifecycle — loader, manager, registry (Phase R8)

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// --- Setup: create a temp plugins dir and mock loader.js constants ---

let TEMP_PLUGINS_DIR;

// Mock logger
vi.mock("../../src/logging/logger.js", () => ({
  createLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
}));

// Mock homedir so PLUGINS_DIR resolves under our temp directory
// Note: pluginsDir() now resolves through dataDir(), which checks FLINT_DATA_DIR
// first. The test sets FLINT_PLUGINS_DIR to control the plugins location, which
// is the supported override for tests.
vi.mock("node:os", async () => {
  const actual = await vi.importActual("node:os");
  return {
    ...actual,
    homedir: () => TEMP_PLUGINS_DIR,
  };
});

// Import AFTER the mock — loader.js computes PLUGINS_DIR from homeDir() at import time
TEMP_PLUGINS_DIR = mkdtempSync(join(tmpdir(), "flint-plugin-test-"));
const pluginsSubDir = join(TEMP_PLUGINS_DIR, ".flint", "plugins");
mkdirSync(pluginsSubDir, { recursive: true });
// pluginsDir() checks FLINT_PLUGINS_DIR first; set it so the test controls
// the plugins location regardless of FLINT_DATA_DIR / homedir().
process.env.FLINT_PLUGINS_DIR = pluginsSubDir;

const { loadPlugins, listInstalledPlugins, getPluginsDir, ensurePluginsDir } =
  await import("../../src/plugins/loader.js");
const { installPlugin, uninstallPlugin } = await import("../../src/plugins/manager.js");
const registry = await import("../../src/tools/registry.js");

// --- Helpers ---

function makePluginDir(name, indexJs, packageJson = null) {
  const dir = join(pluginsSubDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.js"), indexJs);
  if (packageJson) {
    writeFileSync(join(dir, "package.json"), JSON.stringify(packageJson, null, 2));
  }
  return dir;
}

function makeExternalPluginSource(name, indexJs) {
  const root = mkdtempSync(join(tmpdir(), "flint-ext-src-"));
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.js"), indexJs);
  return dir;
}

function clearPluginsDir() {
  if (existsSync(pluginsSubDir)) {
    rmSync(pluginsSubDir, { recursive: true, force: true });
  }
  mkdirSync(pluginsSubDir, { recursive: true });
}

// ---------------------------------------------------------------------------

describe("Plugin lifecycle — loadPlugins", () => {

  beforeEach(() => {
    clearPluginsDir();
  });

  it("returns {loaded: [], errors: []} when plugins dir is empty", async () => {
    const result = await loadPlugins();
    expect(result).toEqual({ loaded: [], errors: [] });
  });

  it("loads valid plugin with correct contract (name, type, version, tools, handlers)", async () => {
    makePluginDir(
      "hello-plugin",
      `export default {
        name: "hello-plugin",
        type: "tool",
        version: "1.2.3",
        description: "A test plugin",
        tools: [{
          type: "function",
          function: { name: "hello_world", description: "Say hi", parameters: { type: "object", properties: {} } }
        }],
        handlers: {
          hello_world: async () => "hi there"
        }
      };`,
    );

    const { loaded, errors } = await loadPlugins();

    expect(errors).toEqual([]);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].name).toBe("hello-plugin");
    expect(loaded[0].type).toBe("tool");
    expect(loaded[0].version).toBe("1.2.3");
    expect(loaded[0].tools).toHaveLength(1);
    expect(loaded[0].handlers.hello_world).toBeTypeOf("function");
  });

  it("fills in defaults for plugin missing optional fields", async () => {
    makePluginDir(
      "minimal",
      `export default { name: "minimal" };`,
    );

    const { loaded } = await loadPlugins();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].name).toBe("minimal");
    expect(loaded[0].type).toBe("tool"); // default
    expect(loaded[0].version).toBe("0.0.0"); // default
    expect(loaded[0].tools).toEqual([]);
    expect(loaded[0].handlers).toEqual({});
  });

  it("infers plugin name from directory when not set in module", async () => {
    makePluginDir(
      "named-from-dir",
      `export default { type: "tool" };`,
    );

    const { loaded } = await loadPlugins();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].name).toBe("named-from-dir");
  });

  it("infers plugin version from package.json when not in module", async () => {
    makePluginDir(
      "pkg-plugin",
      `export default { name: "pkg-plugin" };`,
      { name: "pkg-plugin", version: "7.8.9" },
    );

    const { loaded } = await loadPlugins();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].version).toBe("7.8.9");
  });

  it("skips directory with no index.js (returns null, not an error)", async () => {
    const dir = join(pluginsSubDir, "no-index");
    mkdirSync(dir, { recursive: true });
    // Only package.json, no index.js
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "no-index" }));

    const { loaded, errors } = await loadPlugins();
    expect(loaded).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("captures error from plugin with broken JS", async () => {
    makePluginDir(
      "broken",
      `this is not valid javascript !!!`,
    );

    const { loaded, errors } = await loadPlugins();
    expect(loaded).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0].name).toBe("broken");
    expect(errors[0].error).toBeTruthy();
  });

  it("plugin tools get registered in tool registry via registerPlugin", async () => {
    const toolName = `plugin_tool_${Date.now()}`;
    const plugin = {
      name: "registry-test-plugin",
      type: "tool",
      version: "1.0.0",
      description: "test",
      tools: [
        {
          type: "function",
          function: {
            name: toolName,
            description: "Test plugin tool",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
      handlers: {
        [toolName]: async () => "plugin result",
      },
    };

    registry.registerPlugin(plugin);

    const defs = registry.getDefinitions();
    const found = defs.find(t => t.function.name === toolName);
    expect(found).toBeDefined();

    // Handler is actually executable
    const result = await registry.executeTool(toolName, {});
    expect(result).toBe("plugin result");

    // Plugin appears in loaded list
    const loaded = registry.getLoadedPlugins();
    expect(loaded.some(p => p.name === "registry-test-plugin")).toBe(true);
  });
});

describe("Plugin lifecycle — installPlugin (local path)", () => {

  beforeEach(() => {
    clearPluginsDir();
  });

  it("install from local path copies directory to plugins dir", async () => {
    const srcDir = makeExternalPluginSource(
      "local-plugin",
      `export default { name: "local-plugin", type: "tool", version: "1.0.0" };`,
    );

    const result = await installPlugin(srcDir);
    expect(result.ok).toBe(true);
    expect(result.name).toBe("local-plugin");

    // Verify file was copied
    const targetIndex = join(pluginsSubDir, "local-plugin", "index.js");
    expect(existsSync(targetIndex)).toBe(true);
  });

  it("install rejects when plugin dir already exists", async () => {
    const srcDir = makeExternalPluginSource(
      "dup-plugin",
      `export default { name: "dup-plugin" };`,
    );

    const first = await installPlugin(srcDir);
    expect(first.ok).toBe(true);

    const second = await installPlugin(srcDir);
    expect(second.ok).toBe(false);
    expect(second.error).toMatch(/already installed/i);
  });

  it("ensurePluginsDir creates the directory if missing", () => {
    // Remove the entire .flint tree
    const flintDir = join(TEMP_PLUGINS_DIR, ".flint");
    if (existsSync(flintDir)) rmSync(flintDir, { recursive: true, force: true });
    expect(existsSync(flintDir)).toBe(false);

    const dir = ensurePluginsDir();
    expect(existsSync(dir)).toBe(true);
    expect(dir).toBe(pluginsSubDir);
  });

  it("getPluginsDir returns the computed plugins directory path", () => {
    const dir = getPluginsDir();
    expect(dir).toBe(pluginsSubDir);
  });
});

describe("Plugin lifecycle — uninstallPlugin", () => {

  beforeEach(() => {
    clearPluginsDir();
  });

  it("removes plugin directory", async () => {
    const srcDir = makeExternalPluginSource(
      "removable",
      `export default { name: "removable" };`,
    );
    await installPlugin(srcDir);
    expect(existsSync(join(pluginsSubDir, "removable"))).toBe(true);

    const result = uninstallPlugin("removable");
    expect(result.ok).toBe(true);
    expect(existsSync(join(pluginsSubDir, "removable"))).toBe(false);
  });

  it("returns error for nonexistent plugin", () => {
    const result = uninstallPlugin("does-not-exist-xyz");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not found/i);
  });

  it("uninstall also finds plugins with flint-plugin- prefix", async () => {
    // Simulate an npm-installed plugin directory
    const dir = join(pluginsSubDir, "flint-plugin-example");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "index.js"), `export default { name: "example" };`);

    // User calls uninstall with short name — manager should try both
    const result = uninstallPlugin("example");
    expect(result.ok).toBe(true);
    expect(existsSync(dir)).toBe(false);
  });
});

describe("Plugin lifecycle — listInstalledPlugins", () => {

  beforeEach(() => {
    clearPluginsDir();
  });

  it("returns empty array when no plugins installed", () => {
    expect(listInstalledPlugins()).toEqual([]);
  });

  it("returns plugin directory names", () => {
    mkdirSync(join(pluginsSubDir, "plugin-a"), { recursive: true });
    mkdirSync(join(pluginsSubDir, "plugin-b"), { recursive: true });
    writeFileSync(join(pluginsSubDir, "plugin-a", "index.js"), "export default {};");
    writeFileSync(join(pluginsSubDir, "plugin-b", "index.js"), "export default {};");

    const list = listInstalledPlugins();
    expect(list.sort()).toEqual(["plugin-a", "plugin-b"]);
  });

  it("ignores files at plugins dir root (only counts directories)", () => {
    mkdirSync(join(pluginsSubDir, "real-plugin"), { recursive: true });
    writeFileSync(join(pluginsSubDir, "stray-file.txt"), "not a plugin");

    const list = listInstalledPlugins();
    expect(list).toEqual(["real-plugin"]);
  });
});

// Final cleanup of tmp dir
afterEach(() => {
  // no-op — individual tests use clearPluginsDir; leave tmp root for final test runner cleanup
});
