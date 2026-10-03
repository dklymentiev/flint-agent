// Agent pairing protocol — PIN-based authentication for peer agents

import crypto from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const MAX_ATTEMPTS = 3;
const MAX_SESSIONS = 5;
const PIN_EXPIRY_MS = 180_000; // 3 minutes

/** @type {Map<string, object>} */
const sessions = new Map();

// Paired programs, kept across restarts (owner, 2026-10-02): pairing is the
// only way into the HTTP API by default, so it has to be once per program,
// not once per run. Only a SHA-256 of each token is written, so the file
// grants nothing to whoever reads it. The path is resolved per call, so a
// test's sandboxed home is honoured.
const flintDir = () => join(homedir(), ".flint");
const pairedFile = () => join(flintDir(), "paired-clients.json");

/** @type {Array<{ hash: string, name: string, address: string, pairedAt: string }>|null} */
let clients = null;

const hashOf = (token) => crypto.createHash("sha256").update(String(token)).digest("hex");

function loadClients() {
  if (clients) return clients;
  try {
    const raw = existsSync(pairedFile()) ? JSON.parse(readFileSync(pairedFile(), "utf-8")) : [];
    clients = Array.isArray(raw) ? raw.filter((c) => c && typeof c.hash === "string") : [];
  } catch {
    clients = [];
  }
  return clients;
}

function saveClients() {
  mkdirSync(flintDir(), { recursive: true });
  const tmp = pairedFile() + ".tmp";
  writeFileSync(tmp, JSON.stringify(clients, null, 2), { encoding: "utf-8", mode: 0o600 });
  renameSync(tmp, pairedFile());
}

export function generatePin() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}

export function createPairingSession(fromAddress) {
  cleanExpiredSessions();
  if (sessions.size >= MAX_SESSIONS) {
    return { error: "Too many active pairing sessions" };
  }

  const sessionId = crypto.randomUUID();
  const pin = generatePin();
  const expiresAt = Date.now() + PIN_EXPIRY_MS;

  sessions.set(sessionId, {
    pin,
    attempts: 0,
    expiresAt,
    fromAddress,
    invalidated: false,
  });

  return { sessionId, pin, expiresAt };
}

/**
 * @param {string} sessionId
 * @param {string} candidatePin
 * @param {{ name?: string, address?: string }} [who] - Kept with the pairing, for /paired
 */
export function verifyPin(sessionId, candidatePin, who = {}) {
  const session = sessions.get(sessionId);

  if (!session || session.invalidated) {
    return { valid: false, error: "Invalid or expired session" };
  }

  if (Date.now() > session.expiresAt) {
    sessions.delete(sessionId);
    return { valid: false, error: "Session expired" };
  }

  session.attempts++;

  // Constant-time comparison
  const expected = Buffer.from(session.pin, "utf-8");
  const received = Buffer.from(String(candidatePin).padStart(6, "0"), "utf-8");
  const match =
    expected.length === received.length &&
    crypto.timingSafeEqual(expected, received);

  if (!match) {
    if (session.attempts >= MAX_ATTEMPTS) {
      session.invalidated = true;
      sessions.delete(sessionId);
      return { valid: false, error: "Max attempts exceeded, session invalidated" };
    }
    return {
      valid: false,
      error: `Invalid PIN (${MAX_ATTEMPTS - session.attempts} attempts remaining)`,
    };
  }

  // Success — generate bearer token
  const token = crypto.randomBytes(32).toString("hex");
  loadClients().push({
    hash: hashOf(token),
    name: String(who.name || "unnamed").slice(0, 60),
    address: String(who.address || session.fromAddress || "unknown"),
    pairedAt: new Date().toISOString(),
  });
  saveClients();
  sessions.delete(sessionId);
  return { valid: true, token };
}

export function cleanExpiredSessions() {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now > s.expiresAt || s.invalidated) {
      sessions.delete(id);
    }
  }
}

export function isPairedToken(token) {
  if (!token) return false;
  const h = Buffer.from(hashOf(token), "hex");
  return loadClients().some((c) => {
    const k = Buffer.from(c.hash, "hex");
    return k.length === h.length && crypto.timingSafeEqual(k, h);
  });
}

/** Paired programs, without their hashes. */
export function listPairedClients() {
  return loadClients().map(({ name, address, pairedAt }) => ({ name, address, pairedAt }));
}

/**
 * Revoke the pairings of one program by name, or every pairing with "all".
 * @returns {number} How many were revoked
 */
export function revokePairedClients(nameOrAll) {
  const before = loadClients().length;
  clients = nameOrAll === "all" ? [] : clients.filter((c) => c.name !== nameOrAll);
  const n = before - clients.length;
  if (n > 0 || nameOrAll === "all") saveClients();
  return n;
}

export function revokePairedToken(token) {
  const h = hashOf(token);
  const before = loadClients().length;
  clients = clients.filter((c) => c.hash !== h);
  if (clients.length === before) return false;
  saveClients();
  return true;
}

export function revokeAllPairedTokens() {
  revokePairedClients("all");
}

export function getActiveSessions() {
  cleanExpiredSessions();
  return sessions.size;
}

// For testing
export function _reset() {
  sessions.clear();
  clients = [];
  saveClients();
}
