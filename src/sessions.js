import fs from "node:fs/promises";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { config } from "./config.js";
import { stripTimeStamp } from "./agent/time-stamp.js";

// ── HMAC Integrity ──────────────────────────────────────────

function getSessionKey() {
  if (process.env.AGENT_MEMORY_HMAC_KEY) return process.env.AGENT_MEMORY_HMAC_KEY;
  const keyFile = path.join(config.sessionsDir, ".hmac-key");
  if (existsSync(keyFile)) return readFileSync(keyFile, "utf-8").trim();
  mkdirSync(config.sessionsDir, { recursive: true });
  const key = randomBytes(32).toString("hex");
  writeFileSync(keyFile, key, { encoding: "utf-8", mode: 0o600 });
  return key;
}

function computeSessionHmac(data) {
  return createHmac("sha256", getSessionKey()).update(data, "utf-8").digest("hex");
}

function hmacPath(sessionId) {
  return path.join(config.sessionsDir, `${sessionId}.hmac`);
}

export function generateSessionId() {
  return new Date().toISOString().slice(0, 19).replace(/[:.]/g, "-");
}

export async function saveSession(id, { messages, model, inputHistory, profile, plan, pastedImages, lastSummary, provider, sessionCost, sessionPromptTokens, sessionCompletionTokens }) {
  await fs.mkdir(config.sessionsDir, { recursive: true });
  const filePath = path.join(config.sessionsDir, `${id}.json`);
  const data = {
    id,
    model,
    provider: provider || null,
    updated: new Date().toISOString(),
    cwd: process.cwd(),
    messages,
    inputHistory: inputHistory || [],
    profile: profile || null,
    plan: plan || null,
    pastedImages: pastedImages || [],
    lastSummary: lastSummary || null,
    sessionCost: sessionCost || 0,
    sessionPromptTokens: sessionPromptTokens || 0,
    sessionCompletionTokens: sessionCompletionTokens || 0,
  };
  const json = JSON.stringify(data, null, 2);
  await fs.writeFile(filePath, json, "utf-8");
  // Update HMAC
  writeFileSync(hmacPath(id), computeSessionHmac(json), "utf-8");
}

export async function loadSession(id) {
  const filePath = path.join(config.sessionsDir, `${id}.json`);
  const content = await fs.readFile(filePath, "utf-8");

  // Verify integrity
  const hp = hmacPath(id);
  if (existsSync(hp)) {
    const stored = readFileSync(hp, "utf-8").trim();
    const computed = computeSessionHmac(content);
    try {
      const storedBuf = Buffer.from(stored, "hex");
      const computedBuf = Buffer.from(computed, "hex");
      if (storedBuf.length !== computedBuf.length || !timingSafeEqual(storedBuf, computedBuf)) {
        console.error(`[SECURITY] Session integrity check FAILED for ${id} — possible tampering`);
        throw new Error(`Session ${id} failed integrity check`);
      }
    } catch (err) {
      if (err.message.includes("integrity check")) throw err;
      console.error(`[SECURITY] Session HMAC error for ${id} — rejecting`);
      throw new Error(`Session ${id} failed integrity check`);
    }
  } else if (content.trim().length > 0) {
    // Session data exists without HMAC → auto-heal (migration)
    writeFileSync(hmacPath(id), computeSessionHmac(content), "utf-8");
  }

  return JSON.parse(content);
}

/** A message's text, whether its content is a string or a list of parts. */
function textOf(content) {
  if (typeof content === "string") return stripTimeStamp(content);
  if (Array.isArray(content)) return stripTimeStamp(content.filter((p) => p?.type === "text").map((p) => p.text).join(" ")).trim();
  return "";
}

export async function listSessions() {
  try {
    const files = await fs.readdir(config.sessionsDir);
    const sessions = [];
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const id = file.replace(".json", "");
      try {
        const filePath = path.join(config.sessionsDir, file);
        const raw = await fs.readFile(filePath, "utf-8");
        const data = JSON.parse(raw);
        const userMsg = data.messages?.find((m) => m.role === "user");
        // The last thing the operator asked, for /resume: the first message
        // of a long session says little about where it got to.
        const userMsgs = (data.messages || []).filter((m) => m.role === "user");
        const lastUser = userMsgs[userMsgs.length - 1];
        sessions.push({
          id,
          model: data.model || "?",
          updated: data.updated || "",
          userMessages: userMsgs.length,
          last: textOf(lastUser?.content),
          preview: userMsg
            ? textOf(userMsg.content).length > 60
              ? textOf(userMsg.content).slice(0, 60) + "..."
              : textOf(userMsg.content)
            : "(empty)",
        });
      } catch {
        sessions.push({ id, model: "?", updated: "", preview: "(corrupt)" });
      }
    }
    sessions.sort((a, b) => b.updated.localeCompare(a.updated));
    return sessions;
  } catch {
    return [];
  }
}
