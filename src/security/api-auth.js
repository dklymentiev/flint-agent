// API authentication — token-based auth for the HTTP server

import crypto from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isPairedToken } from "./pairing.js";

const FLINT_DIR = join(homedir(), ".flint");
const TOKEN_FILE = join(FLINT_DIR, "api-token.json");
// Token TTL: 30 days. After expiry, a fresh one is generated on next startup.
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Generate a random 48-character hex token.
 * @returns {string} API token
 */
export function generateApiToken() {
  return crypto.randomBytes(24).toString("hex");
}

/**
 * Load a persisted API token if it exists and hasn't expired.
 * Otherwise generate a new one and persist it.
 * Returns the token string.
 */
export function loadOrCreateApiToken() {
  try {
    if (existsSync(TOKEN_FILE)) {
      const data = JSON.parse(readFileSync(TOKEN_FILE, "utf-8"));
      if (data.token && typeof data.token === "string" && typeof data.expiresAt === "number") {
        if (Date.now() < data.expiresAt) {
          return data.token;
        }
      }
    }
  } catch {
    // Fall through to generate a new token
  }

  const token = generateApiToken();
  try {
    mkdirSync(FLINT_DIR, { recursive: true });
    const payload = {
      token,
      createdAt: Date.now(),
      expiresAt: Date.now() + TOKEN_TTL_MS,
    };
    writeFileSync(TOKEN_FILE, JSON.stringify(payload, null, 2), { encoding: "utf-8", mode: 0o600 });
  } catch {
    // Persist failed — still return the in-memory token
  }
  return token;
}

/**
 * The token-file key to the HTTP API, only when the operator asked for it
 * with FLINT_API_TOKEN_FILE=1 (automation that starts its own Flint).
 *
 * Owner, 2026-10-02: by default nothing can just connect. Any program running
 * as the same user could read ~/.flint/api-token.json and send tasks that run
 * with the API's automatic approval; a benchmark runner drove a console that
 * way. Without the variable no file is read or written, and a program gets in
 * only by pairing (a PIN the operator sees in the console).
 * @returns {string|null}
 */
export function masterTokenIfEnabled() {
  return process.env.FLINT_API_TOKEN_FILE === "1" ? loadOrCreateApiToken() : null;
}

/**
 * Constant-time token comparison.
 */
function tokenEquals(a, b) {
  const bufA = Buffer.from(a, "utf-8");
  const bufB = Buffer.from(b, "utf-8");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Create auth middleware function.
 * @param {string|null} token - The token-file key (masterTokenIfEnabled), or
 *   null: then only paired programs and a parent's spawn secret get in. No
 *   token never means "no auth"; that fail-open let anything in.
 * @returns {Function} (req, res) => boolean — returns true if authorized, false if rejected (response already sent)
 */
export function createAuthMiddleware(token) {
  // Collect additional valid tokens: spawn secret from parent
  const spawnSecret = process.env.AGENT_PAIRING_SECRET || null;

  return function authMiddleware(req, res) {
    // Skip auth for OPTIONS (CORS preflight) and GET /status (health check)
    if (req.method === "OPTIONS") return true;

    const url = new URL(req.url, `http://localhost`);
    if (url.pathname === "/status" && req.method === "GET") return true;

    // Skip auth for pairing endpoints
    if (url.pathname.startsWith("/pair/")) return true;

    // Check Authorization header
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Authorization required. Use: Authorization: Bearer <token>" }));
      return false;
    }

    const parts = authHeader.split(" ");
    if (parts.length !== 2 || parts[0].toLowerCase() !== "bearer") {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid token" }));
      return false;
    }

    const candidate = parts[1];

    // Check the token-file key, when enabled (constant-time)
    if (token && tokenEquals(candidate, token)) return true;

    // Check spawn secret from parent (constant-time)
    if (spawnSecret && tokenEquals(candidate, spawnSecret)) return true;

    // Check paired tokens
    if (isPairedToken(candidate)) return true;

    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid token" }));
    return false;
  };
}
