// Conversation Digest — deterministic per-turn log for context retention
// Stored in sessions/{sessionId}.digest.jsonl
// Zero LLM cost, zero latency — built from data we already have
// Injected into system prompt so model can recall previous turns

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { createHmac } from "node:crypto";
import path from "node:path";
import { config } from "../config.js";

function digestPath(sessionId) {
  return path.join(config.sessionsDir, `${sessionId}.digest.jsonl`);
}

function hmacPath(sessionId) {
  return path.join(config.sessionsDir, `${sessionId}.digest.hmac`);
}

function getHmacKey() {
  if (process.env.AGENT_MEMORY_HMAC_KEY) return process.env.AGENT_MEMORY_HMAC_KEY;
  const keyFile = path.join(config.sessionsDir, ".hmac-key");
  if (existsSync(keyFile)) return readFileSync(keyFile, "utf-8").trim();
  return "default"; // key file created by session-facts.js
}

function updateHmac(sessionId) {
  const fp = digestPath(sessionId);
  if (!existsSync(fp)) return;
  const data = readFileSync(fp, "utf-8");
  const hmac = createHmac("sha256", getHmacKey()).update(data, "utf-8").digest("hex");
  writeFileSync(hmacPath(sessionId), hmac, "utf-8");
}

function verifyHmac(sessionId, data) {
  const hp = hmacPath(sessionId);
  if (!existsSync(hp)) return true; // no HMAC yet — allow (migration)
  const stored = readFileSync(hp, "utf-8").trim();
  const computed = createHmac("sha256", getHmacKey()).update(data, "utf-8").digest("hex");
  return stored === computed;
}

/**
 * Append a digest entry after a completed turn.
 * @param {string} sessionId
 * @param {{ userMessage: string, assistantResponse: string, toolsUsed?: string[] }} entry
 */
export function appendDigestEntry(sessionId, entry) {
  if (!sessionId || !entry) return;
  mkdirSync(config.sessionsDir, { recursive: true });

  const fp = digestPath(sessionId);
  const existing = existsSync(fp) ? readFileSync(fp, "utf-8").split("\n").filter(Boolean).length : 0;

  const record = {
    turn: existing + 1,
    ts: new Date().toISOString(),
    user: truncate(typeof entry.userMessage === "string" ? entry.userMessage : "[multimodal]", 200),
    assistant: truncate(entry.assistantResponse || "", 200),
    tools: entry.toolsUsed || [],
  };

  appendFileSync(fp, JSON.stringify(record) + "\n", "utf-8");
  updateHmac(sessionId);
}

/**
 * Load all digest entries for a session.
 */
export function loadDigest(sessionId) {
  if (!sessionId) return [];
  const fp = digestPath(sessionId);
  if (!existsSync(fp)) return [];
  const raw = readFileSync(fp, "utf-8");
  if (!verifyHmac(sessionId, raw)) return [];
  return raw.split("\n").filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

/**
 * Format digest for injection into system prompt.
 * Returns compact text summary of recent turns.
 * @param {string} sessionId
 * @param {number} maxEntries - max turns to include (newest)
 */
export function getDigestForPrompt(sessionId, maxEntries = 25) {
  const entries = loadDigest(sessionId);
  if (!entries.length) return "";

  const recent = entries.slice(-maxEntries);
  const lines = recent.map((e) => {
    const tools = e.tools.length ? ` [${e.tools.join(", ")}]` : "";
    return `Turn ${e.turn}: "${e.user}" → ${e.assistant}${tools}`;
  });

  return `Conversation digest (${entries.length} turns, showing last ${recent.length}):\n${lines.join("\n")}`;
}

/**
 * Clear digest for a session (used by /clear and /new).
 */
export function clearDigest(sessionId) {
  const fp = digestPath(sessionId);
  if (existsSync(fp)) writeFileSync(fp, "", "utf-8");
  const hp = hmacPath(sessionId);
  if (existsSync(hp)) writeFileSync(hp, "", "utf-8");
}

function truncate(text, maxLen) {
  if (!text) return "";
  const clean = text.replace(/\n/g, " ").trim();
  return clean.length > maxLen ? clean.slice(0, maxLen) + "..." : clean;
}
