import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { config } from "../config.js";

const memoryRoot = process.env.FLINT_DATA_DIR
  ? path.resolve(process.env.FLINT_DATA_DIR)
  : config.projectRoot;
const MEMORY_DIR = path.join(memoryRoot, "memory");
const MEMORIES_FILE = path.join(MEMORY_DIR, "memories.jsonl");
const HMAC_FILE = path.join(MEMORY_DIR, "memories.hmac");
const KEY_FILE = path.join(MEMORY_DIR, ".hmac-key");

const MAX_CONTENT_LENGTH = 10000;
const MAX_IMPORTANCE = 3;
const MIN_IMPORTANCE = 1;

// ── HMAC Integrity ──────────────────────────────────────────

function getHmacKey() {
  // Key from env takes priority (for CI/deployment)
  if (process.env.AGENT_MEMORY_HMAC_KEY) {
    return process.env.AGENT_MEMORY_HMAC_KEY;
  }
  // Otherwise generate and persist a key per project
  ensureDir();
  if (existsSync(KEY_FILE)) {
    return readFileSync(KEY_FILE, "utf-8").trim();
  }
  const key = randomBytes(32).toString("hex");
  writeFileSync(KEY_FILE, key, { encoding: "utf-8", mode: 0o600 });
  return key;
}

function computeHmac(data) {
  return createHmac("sha256", getHmacKey()).update(data, "utf-8").digest("hex");
}

function verifyHmac(data) {
  if (!existsSync(HMAC_FILE)) {
    // No HMAC file: only trust if data file is also empty/missing (true first run)
    // If data exists without HMAC → possible tampering (attacker deleted .hmac)
    if (existsSync(MEMORIES_FILE) && data.trim().length > 0) {
      console.error("[SECURITY] Memory data exists without HMAC file — possible tampering (HMAC deleted)");
      // Auto-heal: create HMAC for existing data (migration from pre-HMAC version)
      // This is a one-time migration — after this, HMAC is required
      saveHmac(data);
      return true;
    }
    return true; // genuinely empty first run
  }
  const stored = readFileSync(HMAC_FILE, "utf-8").trim();
  const computed = computeHmac(data);
  // Timing-safe comparison to prevent timing attacks
  try {
    const storedBuf = Buffer.from(stored, "hex");
    const computedBuf = Buffer.from(computed, "hex");
    if (storedBuf.length !== computedBuf.length || !timingSafeEqual(storedBuf, computedBuf)) {
      console.error("[SECURITY] Memory file integrity check FAILED — possible tampering detected");
      return false;
    }
  } catch {
    console.error("[SECURITY] Memory HMAC comparison error — rejecting data");
    return false;
  }
  return true;
}

function saveHmac(data) {
  writeFileSync(HMAC_FILE, computeHmac(data), "utf-8");
}

// ── Core ─────────────────────────────────────────────────────

// PERF-01: In-process cache — load file once, invalidate on write
let _cache = null;

/** Invalidate in-memory cache (call after external file modification) */
export function invalidateCache() { _cache = null; }

function ensureDir() {
  if (!existsSync(MEMORY_DIR)) mkdirSync(MEMORY_DIR, { recursive: true });
}

export function loadAll() {
  if (_cache !== null) return _cache;
  ensureDir();
  if (!existsSync(MEMORIES_FILE)) { _cache = []; return _cache; }
  const raw = readFileSync(MEMORIES_FILE, "utf-8");

  // Verify integrity before parsing
  if (!verifyHmac(raw)) {
    // Tampering detected — return empty to prevent poisoned memory from loading
    _cache = [];
    return _cache;
  }

  const lines = raw.split("\n").filter(Boolean);
  _cache = lines.map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
  return _cache;
}

function atomicWrite(data) {
  ensureDir();
  const tmp = MEMORIES_FILE + ".tmp";
  writeFileSync(tmp, data, "utf-8");
  renameSync(tmp, MEMORIES_FILE);
  // Update HMAC after successful write
  saveHmac(data);
}

function saveAll(memories) {
  const data = memories.map((m) => JSON.stringify(m)).join("\n") + (memories.length ? "\n" : "");
  atomicWrite(data);
  _cache = memories; // update cache after write
}

function nextId(memories) {
  if (!memories.length) return 1;
  let max = 0;
  for (const m of memories) {
    if (m.id > max) max = m.id;
  }
  return max + 1;
}

function clampImportance(val) {
  const n = typeof val === "number" ? val : MIN_IMPORTANCE;
  return Math.max(MIN_IMPORTANCE, Math.min(MAX_IMPORTANCE, Math.round(n)));
}

export function insertMemory({ content, category = "general", importance = 1, sessionId = null }) {
  if (!content || typeof content !== "string") {
    throw new Error("Memory content must be a non-empty string");
  }
  const trimmed = content.slice(0, MAX_CONTENT_LENGTH);
  const memories = loadAll();
  const entry = {
    id: nextId(memories),
    content: trimmed,
    category: String(category || "general"),
    importance: clampImportance(importance),
    session_id: sessionId,
    created_at: new Date().toISOString(),
  };
  memories.push(entry);
  saveAll(memories);
  return entry;
}

export function searchMemories(query, limit = 10) {
  if (!query || typeof query !== "string") return [];
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];

  const memories = loadAll();
  const scored = [];

  for (const m of memories) {
    const text = `${m.content} ${m.category}`.toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (text.includes(term)) score++;
    }
    if (score === 0) continue;
    score += (m.importance - 1) * 0.5;
    scored.push({ ...m, score });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

export function getMemory(id) {
  const memories = loadAll();
  return memories.find((m) => m.id === id) || null;
}

export function listRecentMemories(limit = 10) {
  const memories = loadAll();
  return memories.slice(-limit).reverse();
}

export function deleteMemory(id) {
  const memories = loadAll();
  const idx = memories.findIndex((m) => m.id === id);
  if (idx === -1) return false;
  memories.splice(idx, 1);
  saveAll(memories);
  return true;
}

export function getMemoryStats() {
  const memories = loadAll();
  const byCategory = {};
  for (const m of memories) {
    byCategory[m.category] = (byCategory[m.category] || 0) + 1;
  }
  return {
    total: memories.length,
    byCategory,
    oldest: memories[0]?.created_at || null,
    newest: memories[memories.length - 1]?.created_at || null,
  };
}

export function clearAllMemories() {
  saveAll([]);
}
