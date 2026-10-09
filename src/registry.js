/**
 * Agent registry -- tracks running Flint instances.
 * File at ~/.flint/agents.json with 0o600 permissions.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import path from "node:path";
import { homeStateDir } from "./data-dir.js";
import { apiUrl } from "./api/address.js";

const FLINT_DIR = homeStateDir();
const REGISTRY_FILE = path.join(FLINT_DIR, "agents.json");

function ensureDir() {
  mkdirSync(FLINT_DIR, { recursive: true, mode: 0o700 });
}

function readRegistry() {
  try {
    if (!existsSync(REGISTRY_FILE)) return [];
    const data = JSON.parse(readFileSync(REGISTRY_FILE, "utf-8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function writeRegistry(entries) {
  const tmp = REGISTRY_FILE + ".tmp." + process.pid;
  try {
    ensureDir();
    writeFileSync(tmp, JSON.stringify(entries, null, 2), { mode: 0o600 });
    renameSync(tmp, REGISTRY_FILE);
  } catch {
    // Rename can fail (e.g. EPERM on Windows when the target is open);
    // clean up the tmp sibling so we don't leak on every write. Previously
    // used `require("node:fs")` mid-function which always threw in ESM,
    // leaving 345 agents.json.tmp.<pid> orphans in ~/.flint over months.
    try { unlinkSync(tmp); } catch {}
  }
}

/**
 * Register this agent instance.
 */
export function registerAgent({ port, sessionId, model, profile, pid, provider, visible }) {
  const entries = readRegistry().filter((e) => e.pid !== pid);
  entries.push({
    port,
    sessionId,
    model,
    profile: profile || "desktop",
    pid,
    provider: provider || null,
    visible: visible !== false,
    startedAt: new Date().toISOString(),
  });
  writeRegistry(entries);
}

/**
 * Unregister this agent instance.
 */
export function unregisterAgent(pid) {
  const entries = readRegistry().filter((e) => e.pid !== pid);
  writeRegistry(entries);
}

/**
 * List all registered agents, optionally checking if they're alive.
 */
export async function listAgents({ checkAlive = false } = {}) {
  let entries = readRegistry();

  if (checkAlive) {
    const alive = [];
    for (const entry of entries) {
      try {
        const res = await fetch(apiUrl(entry.port, "/status"), {
          signal: AbortSignal.timeout(1000),
        });
        if (res.ok) {
          const status = await res.json();
          alive.push({ ...entry, ...status, alive: true });
        }
      } catch {
        // dead -- skip
      }
    }
    // Clean up dead entries
    writeRegistry(alive.map(({ alive, ...rest }) => rest));
    return alive;
  }

  return entries;
}
