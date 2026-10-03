// Encrypted API key storage — per-provider keys in ~/.flint/keys.enc
// Windows: DPAPI-protected seed → AES-256-GCM
// Linux/Mac: PBKDF2 from ~/.flint/.seed + hostname + username → AES-256-GCM

import { createCipheriv, createDecipheriv, randomBytes, pbkdf2Sync } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const FLINT_DIR = path.join(homedir(), ".flint");
const KEYS_FILE = path.join(FLINT_DIR, "keys.enc");

// PBKDF2 iterations for key derivation (NIST-recommended minimum).
const PBKDF2_ITERATIONS = 200000;

let _encryptionKey = null;

async function getEncryptionKey() {
  if (_encryptionKey) return _encryptionKey;

  if (process.platform === "win32") {
    // Windows: DPAPI-protected seed → derived AES key
    const seedFile = path.join(FLINT_DIR, ".seed.dpapi");
    mkdirSync(FLINT_DIR, { recursive: true });

    if (existsSync(seedFile)) {
      try {
        const { unprotectData } = await import("./keys-dpapi.js");
        const protected64 = readFileSync(seedFile, "utf-8").trim();
        const seed = unprotectData(protected64);
        _encryptionKey = pbkdf2Sync(seed, "flint-aes-key", PBKDF2_ITERATIONS, 32, "sha256");
        return _encryptionKey;
      } catch {
        // DPAPI unprotect failed — drop through to regenerate seed
      }
    }

    // Create new DPAPI-protected seed
    try {
      const { protectData } = await import("./keys-dpapi.js");
      const seed = randomBytes(32).toString("hex");
      const protected64 = protectData(seed);
      writeFileSync(seedFile, protected64, { encoding: "utf-8" });
      _encryptionKey = pbkdf2Sync(seed, "flint-aes-key", PBKDF2_ITERATIONS, 32, "sha256");
      return _encryptionKey;
    } catch {
      // DPAPI not available — fall through to cross-platform fallback
    }
  }

  // Linux/Mac (or Windows without DPAPI): PBKDF2 from local seed+salt files
  const { deriveKey } = await import("./keys-fallback.js");
  _encryptionKey = deriveKey();
  return _encryptionKey;
}

function encrypt(plaintext, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return iv.toString("hex") + ":" + Buffer.concat([encrypted, tag]).toString("hex");
}

function decrypt(stored, key) {
  const [ivHex, dataHex] = stored.split(":");
  const iv = Buffer.from(ivHex, "hex");
  const data = Buffer.from(dataHex, "hex");
  const tag = data.subarray(data.length - 16);
  const encrypted = data.subarray(0, data.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(encrypted) + decipher.final("utf-8");
}

function loadKeysFile() {
  if (!existsSync(KEYS_FILE)) return {};
  try {
    return JSON.parse(readFileSync(KEYS_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function saveKeysFile(keys) {
  mkdirSync(FLINT_DIR, { recursive: true });
  writeFileSync(KEYS_FILE, JSON.stringify(keys, null, 2), { encoding: "utf-8" });
}

export async function getKey(providerId) {
  const keys = loadKeysFile();
  const stored = keys[providerId];
  if (!stored) return null;
  try {
    const key = await getEncryptionKey();
    return decrypt(stored, key);
  } catch {
    return null;
  }
}

export async function setKey(providerId, plaintext) {
  const key = await getEncryptionKey();
  const keys = loadKeysFile();
  keys[providerId] = encrypt(plaintext, key);
  saveKeysFile(keys);
}

export async function deleteKey(providerId) {
  const keys = loadKeysFile();
  delete keys[providerId];
  saveKeysFile(keys);
}

export function hasKey(providerId) {
  const keys = loadKeysFile();
  return !!keys[providerId];
}

export function listConfiguredProviders() {
  const keys = loadKeysFile();
  return Object.keys(keys).filter((id) => !id.startsWith(MCP_SECRET_PREFIX));
}

// Secrets for MCP servers (a token for an `Authorization` header) live in the
// same encrypted file as the provider keys, under their own prefix so that
// they are never listed or looked up as a provider. Owner, 2026-10-03: a
// token in .env is a secret in plain text beside the code.
const MCP_SECRET_PREFIX = "mcp:";

/** The names a header may refer to as ${NAME}. */
export const MCP_SECRET_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export async function getMcpSecret(name) {
  return getKey(MCP_SECRET_PREFIX + name);
}

export async function setMcpSecret(name, plaintext) {
  if (!MCP_SECRET_NAME_RE.test(name)) throw new Error(`"${name}" is not a name a header can refer to (letters, digits, _)`);
  await setKey(MCP_SECRET_PREFIX + name, plaintext);
}

export async function deleteMcpSecret(name) {
  await deleteKey(MCP_SECRET_PREFIX + name);
}

/** Names only, never values. */
export function listMcpSecrets() {
  return Object.keys(loadKeysFile())
    .filter((id) => id.startsWith(MCP_SECRET_PREFIX))
    .map((id) => id.slice(MCP_SECRET_PREFIX.length));
}

/** Import a key from an env var into encrypted storage. Used during startup migration. */
export async function migrateEnvKey(envVarName, providerId) {
  const envKey = process.env[envVarName];
  if (!envKey) return false;
  if (hasKey(providerId)) return false; // already stored
  await setKey(providerId, envKey);
  return true;
}
