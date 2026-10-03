// Plugin manager for Flint
// Install/uninstall plugins via npm

import { execSync } from "node:child_process";
import { existsSync, rmSync, mkdirSync, writeFileSync, cpSync } from "node:fs";
import { join } from "node:path";
import { ensurePluginsDir, getPluginsDir } from "./loader.js";

// Install a plugin by npm package name or local path
export async function installPlugin(nameOrPath) {
  const pluginsDir = ensurePluginsDir();

  // Local path install
  if (existsSync(nameOrPath)) {
    const dirName = nameOrPath.split(/[\\/]/).pop();
    const targetDir = join(pluginsDir, dirName);
    if (existsSync(targetDir)) {
      return { ok: false, error: `Plugin "${dirName}" already installed` };
    }
    // Copy directory (no shell — safe from injection)
    cpSync(nameOrPath, targetDir, { recursive: true });
    // Install deps if package.json exists
    if (existsSync(join(targetDir, "package.json"))) {
      try {
        execSync("npm install --omit=dev", { cwd: targetDir, stdio: "pipe" });
      } catch {}
    }
    return { ok: true, name: dirName, path: targetDir };
  }

  // npm package install
  const packageName = nameOrPath.startsWith("flint-plugin-")
    ? nameOrPath
    : `flint-plugin-${nameOrPath}`;

  const targetDir = join(pluginsDir, packageName);
  if (existsSync(targetDir)) {
    return { ok: false, error: `Plugin "${packageName}" already installed` };
  }

  try {
    mkdirSync(targetDir, { recursive: true });
    // Create minimal package.json so npm install works
    writeFileSync(
      join(targetDir, "package.json"),
      JSON.stringify({ name: packageName, version: "0.0.0", dependencies: { [packageName]: "latest" } }, null, 2),
    );
    execSync("npm install --omit=dev", { cwd: targetDir, stdio: "pipe", timeout: 60000 });

    // Check if the package has an index.js or main entry
    const pkgDir = join(targetDir, "node_modules", packageName);
    if (!existsSync(pkgDir)) {
      rmSync(targetDir, { recursive: true, force: true });
      return { ok: false, error: `Package "${packageName}" not found on npm` };
    }

    // Create index.js that re-exports the package
    writeFileSync(
      join(targetDir, "index.js"),
      `export { default } from "${packageName}";\n`,
    );

    return { ok: true, name: packageName, path: targetDir };
  } catch (err) {
    // Cleanup on failure
    if (existsSync(targetDir)) {
      rmSync(targetDir, { recursive: true, force: true });
    }
    return { ok: false, error: err.message };
  }
}

// Uninstall a plugin
export function uninstallPlugin(name) {
  const pluginsDir = getPluginsDir();
  const packageName = name.startsWith("flint-plugin-") ? name : `flint-plugin-${name}`;

  // Try both with and without prefix
  for (const dirName of [name, packageName]) {
    const targetDir = join(pluginsDir, dirName);
    if (existsSync(targetDir)) {
      rmSync(targetDir, { recursive: true, force: true });
      return { ok: true, name: dirName };
    }
  }

  return { ok: false, error: `Plugin "${name}" not found` };
}
