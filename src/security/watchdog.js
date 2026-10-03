// Watchdog — periodic checks for memory usage and self-modification

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AGENT_SRC_DIR = path.resolve(__dirname, "..");

const HEAP_WARN_BYTES = 500 * 1024 * 1024; // 500 MB
const CHECK_INTERVAL = 30000; // 30 seconds

let watchdogTimer = null;
let initialHash = null;

/**
 * Compute a hash of all file mtimes and sizes in src/.
 * This detects self-modification of the agent source.
 */
function computeSrcHash() {
  const hasher = crypto.createHash("sha256");
  try {
    collectFiles(AGENT_SRC_DIR, hasher, 0);
  } catch {
    // If we can't read src, return a sentinel
    return "unreadable";
  }
  return hasher.digest("hex");
}

function collectFiles(dir, hasher, depth) {
  if (depth > 10) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  // Sort for consistent hash
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(full, hasher, depth + 1);
    } else {
      try {
        const stat = fs.statSync(full);
        hasher.update(`${full}:${stat.size}:${stat.mtimeMs}\n`);
      } catch {
        // skip unreadable files
      }
    }
  }
}

/**
 * Start the watchdog timer.
 * @param {object} store - Zustand store
 * @param {object} config - App config
 * @param {object} [auditFns] - { auditLog } for logging alerts
 * @returns {Function} stopWatchdog — call to stop the timer
 */
export function startWatchdog(store, config, auditFns) {
  const auditLog = auditFns?.auditLog || (() => {});

  // Capture initial state
  initialHash = computeSrcHash();

  watchdogTimer = setInterval(() => {
    try {
      // 1. Memory check
      const mem = process.memoryUsage();
      if (mem.heapUsed > HEAP_WARN_BYTES) {
        const mb = (mem.heapUsed / 1024 / 1024).toFixed(0);
        auditLog("WATCHDOG_ALERT", null, {}, {
          alert: "high_memory",
          heapUsedMB: mb,
        });
      }

      // 2. Self-modification detection
      const currentHash = computeSrcHash();
      if (initialHash && currentHash !== initialHash && currentHash !== "unreadable") {
        auditLog("WATCHDOG_ALERT", null, {}, {
          alert: "src_modified",
          message: "Agent source files have been modified since startup",
        });
        // Update hash so we don't spam alerts
        initialHash = currentHash;
      }
    } catch {
      // Watchdog failures are non-fatal
    }
  }, CHECK_INTERVAL);

  // Don't block Node.js exit
  if (watchdogTimer.unref) watchdogTimer.unref();

  return function stopWatchdog() {
    if (watchdogTimer) {
      clearInterval(watchdogTimer);
      watchdogTimer = null;
    }
  };
}
