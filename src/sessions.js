import fs from "node:fs/promises";
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
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

// ── Session lock (prevents two processes writing the same session) ──────
//
// A lock file <id>.lock next to <id>.json records the pid and start time of
// the process that opened the session. A second process that tries to load
// or create the same id refuses with a clear message and a non-zero exit,
// instead of racing on the same .json and silently overwriting one writer's
// history.
//
// Stale locks are recovered: if the recorded pid is not alive the lock is
// taken over by the new process. This means an ancestor killed by SIGKILL or
// OOM (no chance to run cleanup) does not strand the session behind a lock
// that "never heals". isPidAlive is a best-effort signal — a pid can be
// reused — so a stale lock is replaced, not trusted.

export function lockPath(sessionId) {
  return path.join(config.sessionsDir, `${sessionId}.lock`);
}

/** True if a process with the given pid exists (best-effort). */
function isPidAlive(pid) {
  // signal 0 checks existence without sending a signal. ESRCH = no such
  // process; the process is gone. Negative pids are process-group kills and
  // are treated as alive so a lock is never dropped for an invalid handle.
  if (!pid || pid < 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM"; // exists but not ours
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Locks this process holds, released synchronously on exit. process.exit()
// and normal termination both fire "exit"; SIGINT/SIGTERM handlers in
// index.js end in process.exit(), so they reach it too. SIGKILL cannot, which
// is what the stale-lock takeover is for. Without this the .lock outlived
// every clean run, and a reused pid (reboot, container) then read as a live
// owner: a false "already in use".
const heldLocks = new Set();
let exitHookInstalled = false;

function releaseHeldLocksSync() {
  for (const id of heldLocks) {
    try {
      const data = JSON.parse(readFileSync(lockPath(id), "utf-8"));
      if (data && data.pid === process.pid) unlinkSync(lockPath(id));
    } catch {}
  }
  heldLocks.clear();
}

function holdLock(sessionId) {
  heldLocks.add(sessionId);
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.on("exit", releaseHeldLocksSync);
  }
}

const GONE = Symbol("gone");

/**
 * Read a lock file. A creator opens it ("wx") before it writes the pid, so an
 * empty or half-written file is a lock being born, not a stale one: wait for
 * it to fill. Returns the parsed lock, GONE when the file is not there, or
 * null when it stays unreadable for the whole wait (a creator that died
 * between open and write).
 */
async function readLockSettled(lp) {
  for (let i = 0; i < 20; i++) {
    let raw;
    try { raw = await fs.readFile(lp, "utf-8"); } catch (e) {
      if (e.code === "ENOENT") return GONE;
      throw e;
    }
    try {
      const data = JSON.parse(raw);
      if (data && typeof data === "object") return data;
    } catch {}
    await sleep(25);
  }
  return null;
}

async function createLockFile(lp) {
  const fd = await fs.open(lp, "wx", 0o600);
  try {
    await fd.writeFile(JSON.stringify({ pid: process.pid, startedAt: Date.now() }), "utf-8");
  } finally {
    await fd.close();
  }
}

/**
 * Acquire the lock for a session id. Throws when another live process holds
 * it; returns normally when the lock is ours (newly created or recovered
 * from a dead writer).
 *
 * @param {string} sessionId
 * @returns {Promise<boolean>} true when this caller now holds the lock
 * @throws {Error} when a live process already holds the lock
 */
export async function acquireSessionLock(sessionId) {
  await fs.mkdir(config.sessionsDir, { recursive: true });
  const lp = lockPath(sessionId);
  const inUse = (pid) => new Error(
    `Session "${sessionId}" is already in use by process ${pid}. ` +
    "A second process must not write the same session while another is running."
  );
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      // Atomic create: fail if the file already exists.
      await createLockFile(lp);
      holdLock(sessionId);
      return true;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
    const existing = await readLockSettled(lp);
    if (existing === GONE) continue;
    // Same process: harmless re-entrancy. A single Node process is
    // single-threaded and can never be two concurrent writers of one session,
    // so a lock this very process already holds does not block it. This keeps
    // in-process callers that re-enter bootstrap() (tests, restarts that
    // regenerate a same-second id) working, while still protecting against a
    // genuinely different process.
    if (existing && existing.pid === process.pid) {
      await fs.writeFile(lp, JSON.stringify({ pid: process.pid, startedAt: Date.now() }), "utf-8");
      holdLock(sessionId);
      return true;
    }
    if (existing && isPidAlive(existing.pid)) throw inUse(existing.pid);

    // Stale lock (dead owner, or never filled in). Two processes can reach
    // this point together, so the takeover is serialised by a second
    // exclusive file: only its holder may remove the stale lock, and it
    // re-checks the lock under that guard before doing so.
    const guard = `${lp}.takeover`;
    let guardFd;
    try {
      guardFd = await fs.open(guard, "wx", 0o600);
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      // A guard older than a few seconds belongs to a taker that died.
      try {
        const st = await fs.stat(guard);
        if (Date.now() - st.mtimeMs > 5000) await fs.unlink(guard);
      } catch {}
      await sleep(25);
      continue;
    }
    try {
      const again = await readLockSettled(lp);
      if (again && again !== GONE && again.pid !== process.pid && isPidAlive(again.pid)) throw inUse(again.pid);
      if (again !== GONE) await fs.unlink(lp).catch(() => {});
      try {
        await createLockFile(lp);
        holdLock(sessionId);
        return true;
      } catch (e) {
        if (e.code !== "EEXIST") throw e;
        // A fresh creator slipped in between our unlink and create; loop and
        // judge its lock like any other.
      }
    } finally {
      await guardFd.close().catch(() => {});
      await fs.unlink(guard).catch(() => {});
    }
  }
  throw new Error(`Session "${sessionId}": could not settle the lock file ${lp}`);
}

/** Release the lock, but only when we still own it. */
export async function releaseSessionLock(sessionId) {
  const lp = lockPath(sessionId);
  heldLocks.delete(sessionId);
  try {
    const raw = await fs.readFile(lp, "utf-8");
    const data = JSON.parse(raw);
    if (data && data.pid === process.pid) {
      await fs.unlink(lp).catch(() => {});
    }
  } catch {}
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

  try {
    return JSON.parse(content);
  } catch (e) {
    // Not the same as "no such session": the file is there and unreadable.
    // Callers that fall back to a fresh session must not then overwrite it.
    const err = new Error(`Session ${id} is corrupt (${e.message})`);
    err.code = "SESSION_CORRUPT";
    throw err;
  }
}

/**
 * Move a corrupt session aside as <id>.json.corrupt (with its .hmac) so the
 * history stays on disk and a fresh session can take the id.
 * @returns {Promise<string>} path of the kept file
 */
export async function quarantineSession(id) {
  const from = path.join(config.sessionsDir, `${id}.json`);
  let to = `${from}.corrupt`;
  if (existsSync(to)) to = `${from}.${Date.now()}.corrupt`;
  await fs.rename(from, to);
  await fs.rename(hmacPath(id), `${to}.hmac`).catch(() => {});
  return to;
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
