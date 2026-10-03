// Provider registry — loads from config/providers.json, falls back to bundled defaults

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, "../../config/providers.json");
// homedir(), not process.env.HOME: HOME is unset on Windows.
const USER_CONFIG_PATH = join(homedir(), ".flint", "providers.json");

function loadProviders() {
  // User config (~/.flint/providers.json) takes priority, then project config
  for (const path of [USER_CONFIG_PATH, CONFIG_PATH]) {
    try {
      if (existsSync(path)) {
        const raw = JSON.parse(readFileSync(path, "utf-8"));
        // Add id field from key if missing
        const providers = {};
        for (const [id, def] of Object.entries(raw)) {
          if (id.startsWith("_")) continue; // skip comments
          providers[id] = { id, headers: {}, ...def };
        }
        return providers;
      }
    } catch {}
  }
  // Should not happen — config/providers.json is bundled
  return {};
}

export const PROVIDERS = loadProviders();

export function getProvider(id) {
  return PROVIDERS[id] || null;
}

export function listProviders() {
  return Object.values(PROVIDERS);
}

export function getProviderIds() {
  return Object.keys(PROVIDERS);
}

/**
 * Reload providers from config (e.g. after user edits ~/.flint/providers.json).
 */
export function reloadProviders() {
  const fresh = loadProviders();
  // Clear and repopulate
  for (const key of Object.keys(PROVIDERS)) delete PROVIDERS[key];
  Object.assign(PROVIDERS, fresh);
  return PROVIDERS;
}
