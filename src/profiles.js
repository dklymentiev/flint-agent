// Profile loader — reads profile configs and prompt files
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";

const PROFILES_DIR = join(config.projectRoot, "profiles");

export function loadProfilesConfig() {
  try {
    return JSON.parse(readFileSync(join(PROFILES_DIR, "profiles.json"), "utf-8"));
  } catch {
    return {};
  }
}

export function loadProfile(name) {
  const configs = loadProfilesConfig();
  const cfg = configs[name];
  if (!cfg) throw new Error(`Profile "${name}" not found in profiles.json`);
  const filePath = join(PROFILES_DIR, cfg.prompt);
  try {
    const content = readFileSync(filePath, "utf-8").trim();
    return {
      content,
      contextMode: cfg.contextMode || "mini",
      windowSize: cfg.windowSize || 10,
      description: cfg.description || "",
    };
  } catch {
    throw new Error(`Profile prompt "${cfg.prompt}" not found at ${filePath}`);
  }
}

export function listProfiles() {
  const configs = loadProfilesConfig();
  return Object.keys(configs);
}

export function getProfileDescription(name) {
  const configs = loadProfilesConfig();
  return configs[name]?.description || "";
}
