// Linux/Mac fallback — PBKDF2 key derivation with random seed + random salt

import { randomBytes, pbkdf2Sync } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const FLINT_DIR = path.join(homedir(), ".flint");
const SEED_FILE = path.join(FLINT_DIR, ".seed");
const SALT_FILE = path.join(FLINT_DIR, ".salt");
const ITERATIONS = 600000; // NIST SP 800-132 minimum for SHA-256

function ensureDir() {
  mkdirSync(FLINT_DIR, { recursive: true, mode: 0o700 });
}

function getOrCreateFile(filePath) {
  ensureDir();
  if (existsSync(filePath)) {
    return readFileSync(filePath, "utf-8").trim();
  }
  const value = randomBytes(32).toString("hex");
  writeFileSync(filePath, value, { encoding: "utf-8", mode: 0o600 });
  return value;
}

export function deriveKey() {
  const seed = getOrCreateFile(SEED_FILE);
  const salt = getOrCreateFile(SALT_FILE);
  return pbkdf2Sync(seed, salt, ITERATIONS, 32, "sha256");
}
