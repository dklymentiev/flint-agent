// Provider state persistence — active provider + last model per provider
// File: ~/.flint/provider.json

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { homeStateDir } from "../data-dir.js";

const FLINT_DIR = homeStateDir();
const STATE_FILE = path.join(FLINT_DIR, "provider.json");

const DEFAULT_STATE = {
  activeProvider: "openrouter",
  lastModel: {},
};

function load() {
  if (!existsSync(STATE_FILE)) return { ...DEFAULT_STATE, lastModel: {} };
  try {
    const data = JSON.parse(readFileSync(STATE_FILE, "utf-8"));
    return {
      activeProvider: data.activeProvider || DEFAULT_STATE.activeProvider,
      lastModel: data.lastModel || {},
    };
  } catch {
    return { ...DEFAULT_STATE, lastModel: {} };
  }
}

function save(state) {
  mkdirSync(FLINT_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
}

export function getActiveProvider() {
  return load().activeProvider;
}

export function setActiveProvider(providerId) {
  const state = load();
  state.activeProvider = providerId;
  save(state);
}

export function getLastModel(providerId) {
  return load().lastModel[providerId] || null;
}

export function setLastModel(providerId, modelId) {
  const state = load();
  state.lastModel[providerId] = modelId;
  save(state);
}

export function getProviderState() {
  return load();
}
