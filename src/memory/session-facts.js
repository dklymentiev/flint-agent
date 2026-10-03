// Per-session fact storage — each session has its own facts file
// Stored in sessions/{sessionId}.facts.jsonl
// HMAC integrity protection against tampering

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { config } from "../config.js";

function factsPath(sessionId) {
  return path.join(config.sessionsDir, `${sessionId}.facts.jsonl`);
}

function hmacPath(sessionId) {
  return path.join(config.sessionsDir, `${sessionId}.facts.hmac`);
}

function getFactsKey() {
  if (process.env.AGENT_MEMORY_HMAC_KEY) return process.env.AGENT_MEMORY_HMAC_KEY;
  const keyFile = path.join(config.sessionsDir, ".hmac-key");
  if (existsSync(keyFile)) return readFileSync(keyFile, "utf-8").trim();
  mkdirSync(config.sessionsDir, { recursive: true });
  const key = randomBytes(32).toString("hex");
  writeFileSync(keyFile, key, { encoding: "utf-8", mode: 0o600 });
  return key;
}

function computeFactsHmac(data) {
  return createHmac("sha256", getFactsKey()).update(data, "utf-8").digest("hex");
}

function verifyFactsHmac(sessionId, data) {
  const hp = hmacPath(sessionId);
  if (!existsSync(hp)) {
    // If facts file has data but no HMAC → auto-heal (migration)
    if (data.trim().length > 0) {
      updateFactsHmac(sessionId);
    }
    return true;
  }
  const stored = readFileSync(hp, "utf-8").trim();
  const computed = computeFactsHmac(data);
  try {
    const storedBuf = Buffer.from(stored, "hex");
    const computedBuf = Buffer.from(computed, "hex");
    if (storedBuf.length !== computedBuf.length || !timingSafeEqual(storedBuf, computedBuf)) {
      console.error(`[SECURITY] Session facts integrity FAILED for ${sessionId} — possible tampering`);
      return false;
    }
  } catch {
    console.error(`[SECURITY] Session facts HMAC error for ${sessionId} — rejecting`);
    return false;
  }
  return true;
}

function updateFactsHmac(sessionId) {
  const fp = factsPath(sessionId);
  if (!existsSync(fp)) return;
  const data = readFileSync(fp, "utf-8");
  writeFileSync(hmacPath(sessionId), computeFactsHmac(data), "utf-8");
}

export function saveSessionFact(sessionId, fact) {
  if (!sessionId || !fact?.content) return;
  mkdirSync(config.sessionsDir, { recursive: true });
  const entry = {
    content: fact.content,
    category: fact.category || "auto",
    source: fact.source || "compression",
    created_at: new Date().toISOString(),
  };
  appendFileSync(factsPath(sessionId), JSON.stringify(entry) + "\n", "utf-8");
  updateFactsHmac(sessionId);
  return entry;
}

export function saveSessionFacts(sessionId, facts) {
  if (!sessionId || !facts?.length) return;
  for (const fact of facts) {
    saveSessionFact(sessionId, fact);
  }
}

export function loadSessionFacts(sessionId) {
  if (!sessionId) return [];
  const fp = factsPath(sessionId);
  if (!existsSync(fp)) return [];
  const raw = readFileSync(fp, "utf-8");

  if (!verifyFactsHmac(sessionId, raw)) {
    return []; // tampering detected — return empty
  }

  const lines = raw.split("\n").filter(Boolean);
  return lines.map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

export function getSessionFactsSummary(sessionId, maxLines = 30) {
  const facts = loadSessionFacts(sessionId);
  if (!facts.length) return "";

  const grouped = {};
  for (const f of facts) {
    const cat = f.category || "auto";
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(f);
  }

  let summary = `Session facts (${facts.length}):\n`;
  for (const [cat, items] of Object.entries(grouped)) {
    summary += `[${cat}]\n`;
    for (const f of items.slice(-maxLines)) {
      summary += `- ${f.content}\n`;
    }
  }
  return summary;
}

export function clearSessionFacts(sessionId) {
  const fp = factsPath(sessionId);
  if (existsSync(fp)) writeFileSync(fp, "", "utf-8");
}
