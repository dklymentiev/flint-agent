// Project scope detection.
//
// Facts are split into global (about the user) and project-scoped (about a
// specific project). This file resolves "what project are we currently in?"
// so the rest of the memory layer can filter appropriately.
//
// Priority:
//   1. Explicit override via setCurrentProject(name) — from /project set
//   2. MEMORY.md in current workspace contains `project: <name>` frontmatter
//   3. CWD leaf name (last path segment) matches a known project from registry
//   4. Fallback: null (no project scope; everything treated as global)

import { readFileSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { config } from "../config.js";

let _explicitProject = null;

/**
 * Explicit override — set by /project set NAME. Takes priority over detection.
 */
export function setCurrentProject(name) {
  _explicitProject = name ? String(name).trim().toLowerCase() : null;
}

/**
 * Clear the explicit override and fall back to detection.
 */
export function clearCurrentProject() {
  _explicitProject = null;
}

/**
 * Detect the current project name.
 *
 * @param {string} [cwd=config.baseDir] — the folder the agent works in (not Flint's install folder)
 * @returns {string|null} lowercase project name, or null if no project
 */
export function getCurrentProject(cwd = config.baseDir || process.cwd()) {
  if (_explicitProject) return _explicitProject;

  // 2. MEMORY.md with `project:` frontmatter
  try {
    const memoryPath = join(cwd, "MEMORY.md");
    if (existsSync(memoryPath)) {
      const content = readFileSync(memoryPath, "utf-8").slice(0, 1000);
      const match = content.match(/^project:\s*([a-z0-9-_]+)/im);
      if (match) return match[1].toLowerCase();
    }
  } catch {}

  // 3. CWD leaf — only if it matches a plausible project pattern.
  // Using leaf makes this automatic for users working in repo dirs like
  // `flint-agent`, `my-app`, `screenbox`. Normalised: lowercased, strip trailing
  // suffixes like "-agent" that are tooling-specific.
  try {
    const leaf = basename(cwd).toLowerCase();
    // Ignore generic names that could collide: "src", "tmp", "home", "desktop"
    const ignored = new Set(["src", "tmp", "temp", "home", "desktop", "documents", "downloads", "node_modules", ""]);
    if (leaf && !ignored.has(leaf) && /^[a-z0-9][a-z0-9-_]{1,40}$/.test(leaf)) {
      // Strip common suffixes
      return leaf.replace(/-agent$|-app$|-site$/, "");
    }
  } catch {}

  return null;
}
