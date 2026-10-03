// Checkpoint/Rewind — snapshot files before modification
// Stores original content so changes can be undone with /rewind

import fs from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

// Stack of snapshots (LIFO) — each entry is { path, content, type, timestamp }
// content = null means file didn't exist before (was created)
const stack = [];

// Backlog item 12. This stack is never popped in normal use: saveCheckpoint is
// called before every write_file, edit_file and delete_file, and only /rewind
// removes entries. So a working day of edits accumulated a copy of every file,
// before every edit, for as long as the process lived — and /new does not touch
// it, which is exactly what the owner saw: 2.93 GB, /new at 07:08, 3.05 GB
// after, i.e. the session's history went and the memory did not.
//
// Bounded by DEPTH, not by size. Size alone is the wrong unit: a few very
// large files pass a byte limit that hundreds of ordinary ones blow through,
// and the count is what the /rewind command can actually act on ("rewind the
// last 3 changes"). 50 entries is more than any human undo session — it covers
// the writes of a long turn and leaves room to go back further than anyone
// asks — and the oldest fall off, which is the order rewind already works in.
//
// The tradeoff is real and worth stating: a rewind past DEPTH can no longer
// restore a file. That is the price of not dying at 4 GB, and it is the right
// way round: the alternative is losing the whole session to the heap limit.
//
// Exported so the measurement test in checkpoint.test.js asserts against this
// number rather than a copy of it. A test with its own "50" in it would keep
// passing if the bound were ever changed, which is the opposite of what it is
// for.
export const MAX_DEPTH = 50;

function trim() {
  while (stack.length > MAX_DEPTH) stack.shift();
}

/**
 * Save a snapshot of a file before modifying it.
 * Call this BEFORE write_file, edit_file, delete_file.
 */
export async function saveCheckpoint(filePath, type = "modify") {
  const resolved = path.resolve(filePath);
  let content = null;
  let existed = false;

  try {
    content = readFileSync(resolved, "utf-8");
    existed = true;
  } catch {
    // File doesn't exist yet — will be created
    existed = false;
  }

  stack.push({
    path: resolved,
    content: existed ? content : null,
    existed,
    type, // "write", "edit", "delete"
    timestamp: Date.now(),
  });
  trim();
}

/**
 * Rewind last N changes (default 1).
 * Returns array of restored file descriptions.
 */
export async function rewind(count = 1) {
  const restored = [];

  for (let i = 0; i < count && stack.length > 0; i++) {
    const snap = stack.pop();

    if (!snap.existed) {
      // File was created — delete it
      try {
        await fs.unlink(snap.path);
        restored.push({ path: snap.path, action: "deleted (was new)" });
      } catch {
        restored.push({ path: snap.path, action: "already gone" });
      }
    } else {
      // File existed — restore original content
      try {
        await fs.mkdir(path.dirname(snap.path), { recursive: true });
        await fs.writeFile(snap.path, snap.content, "utf-8");
        restored.push({ path: snap.path, action: "restored" });
      } catch (err) {
        restored.push({ path: snap.path, action: `error: ${err.message}` });
      }
    }
  }

  return restored;
}

/**
 * Rewind all changes in the stack.
 */
export async function rewindAll() {
  return rewind(stack.length);
}

/**
 * Get stack info without modifying it.
 */
export function getCheckpointStack() {
  return stack.map((s) => ({
    path: s.path,
    type: s.type,
    existed: s.existed,
    timestamp: s.timestamp,
  }));
}

/**
 * Clear checkpoint stack (e.g. on session reset).
 */
export function clearCheckpoints() {
  stack.length = 0;
}

/**
 * Number of checkpoints in the stack.
 */
export function checkpointCount() {
  return stack.length;
}

/**
 * How many bytes of file content the stack is holding right now.
 *
 * A measurement, not a leak of content: it sums the sizes and returns a
 * number, so a test can watch the stack grow without the accessor handing out
 * the file text (getCheckpointStack deliberately maps `content` out — see the
 * security test in checkpoint.test.js).
 *
 * This is the number that matters for memory growth. The owner watched one
 * process climb from 2.43 GB to 3.33 GB overnight and die at ~4 GB on
 * "JavaScript heap out of memory"; /new dropped it only to 3.05 GB, so the
 * message history was not what grew. What grew was state outside the session.
 * This is the part of that state which holds whole files, once per edit, for
 * the life of the process.
 */
export function checkpointRetainedBytes() {
  let bytes = 0;
  for (const s of stack) bytes += s.content ? Buffer.byteLength(s.content, "utf-8") : 0;
  return bytes;
}
