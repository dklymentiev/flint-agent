/**
 * Log collector — background cleanup of old session files and stale registry entries.
 *
 * Runs once at startup (after a short delay) then periodically (default: every hour).
 * Configurable via env:
 *   AGENT_LOG_RETENTION_DAYS  — delete logs older than N days (default: 7)
 *   AGENT_SESSION_RETENTION_DAYS — delete session JSONs older than N days (default: 30)
 *   AGENT_CLEANUP_INTERVAL_MIN — interval in minutes (default: 60)
 */

import { readdirSync, statSync, unlinkSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { createLogger } from "./logger.js";
import { cleanup as busCleanupFn } from "../bus/index.js";
import { homeStateDir, installStateDir } from "../data-dir.js";

const log = createLogger("collector");

const LOG_RETENTION_DAYS = parseInt(process.env.AGENT_LOG_RETENTION_DAYS || "7", 10);
const SESSION_RETENTION_DAYS = parseInt(process.env.AGENT_SESSION_RETENTION_DAYS || "30", 10);
const CLEANUP_INTERVAL_MIN = parseInt(process.env.AGENT_CLEANUP_INTERVAL_MIN || "60", 10);

// File extensions considered "log files" (shorter retention)
const LOG_EXTENSIONS = new Set([".log"]);
// Session data files (longer retention)
const SESSION_EXTENSIONS = new Set([".json", ".hmac"]);

function isExpired(filePath, retentionDays) {
  try {
    const stat = statSync(filePath);
    const ageMs = Date.now() - stat.mtimeMs;
    return ageMs > retentionDays * 86400000;
  } catch {
    return false;
  }
}

function getExtGroup(filename) {
  // e.g. "2026-03-13T03-56-39.api.log" → ".log"
  // e.g. "2026-03-13T03-56-39.json" → ".json"
  const ext = path.extname(filename); // last extension
  if (LOG_EXTENSIONS.has(ext)) return "log";
  if (SESSION_EXTENSIONS.has(ext)) return "session";
  return null;
}

function cleanDirectory(dir) {
  if (!existsSync(dir)) return { logsRemoved: 0, sessionsRemoved: 0 };

  let logsRemoved = 0;
  let sessionsRemoved = 0;

  try {
    const files = readdirSync(dir);
    for (const file of files) {
      // Skip special files
      if (file.startsWith(".")) continue;

      const group = getExtGroup(file);
      if (!group) continue;

      const filePath = path.join(dir, file);
      const retention = group === "log" ? LOG_RETENTION_DAYS : SESSION_RETENTION_DAYS;

      if (isExpired(filePath, retention)) {
        try {
          unlinkSync(filePath);
          if (group === "log") logsRemoved++;
          else sessionsRemoved++;
        } catch {}
      }
    }
  } catch (err) {
    log.warn("Failed to read directory for cleanup", { dir, error: err.message });
  }

  return { logsRemoved, sessionsRemoved };
}

async function cleanRegistry() {
  const { homeStateDir } = await import("../data-dir.js");
  const { join } = await import("node:path");
  const registryFile = join(homeStateDir(), "agents.json");

  if (!existsSync(registryFile)) return 0;

  try {
    const data = JSON.parse(readFileSync(registryFile, "utf-8"));
    if (!Array.isArray(data)) return 0;

    const before = data.length;
    const alive = data.filter((entry) => {
      try {
        // Check if process is still running
        process.kill(entry.pid, 0);
        return true;
      } catch {
        return false;
      }
    });

    if (alive.length < before) {
      writeFileSync(registryFile, JSON.stringify(alive, null, 2));
    }

    return before - alive.length;
  } catch {
    return 0;
  }
}

function runCollector() {
  log.debug("Log collector running");

  // Clean main sessions directory
  const main = cleanDirectory(config.sessionsDir);

  // Clean children sessions directory (for parent/AGENT_PARENT_PORT spawns)
  const childrenDir = path.join(installStateDir(), "sessions", "children");
  const children = cleanDirectory(childrenDir);

  // Clean stale registry entries
  const registryCleaned = cleanRegistry();

  // Clean old bus messages
  let busCleanup = { done: 0, failed: 0 };
  try {
    busCleanup = busCleanupFn();
  } catch {}

  const totalLogs = main.logsRemoved + children.logsRemoved;
  const totalSessions = main.sessionsRemoved + children.sessionsRemoved;
  const totalBus = busCleanup.done + busCleanup.failed;

  if (totalLogs > 0 || totalSessions > 0 || registryCleaned > 0 || totalBus > 0) {
    log.info("Cleanup complete", {
      logsRemoved: totalLogs,
      sessionsRemoved: totalSessions,
      registryCleaned,
      busMessagesRemoved: totalBus,
    });
  } else {
    log.debug("Cleanup complete — nothing to remove");
  }
}

let _interval = null;

/**
 * Start the background log collector.
 * Runs immediately (after 5s delay), then every CLEANUP_INTERVAL_MIN minutes.
 */
export function startLogCollector() {
  // Initial run after 5 seconds (let the app finish starting up)
  const initialTimer = setTimeout(runCollector, 5000);
  initialTimer.unref();

  // Periodic run
  _interval = setInterval(runCollector, CLEANUP_INTERVAL_MIN * 60000);
  _interval.unref(); // Don't keep process alive just for cleanup

  log.info("Log collector started", {
    logRetentionDays: LOG_RETENTION_DAYS,
    sessionRetentionDays: SESSION_RETENTION_DAYS,
    intervalMin: CLEANUP_INTERVAL_MIN,
  });
}

/**
 * Stop the background log collector.
 */
export function stopLogCollector() {
  if (_interval) {
    clearInterval(_interval);
    _interval = null;
  }
}

/**
 * Run collector once (for manual/command use).
 */
export { runCollector };
