// What a turn changed, read off the folders it works in rather than off the
// names of the tools it called.
//
// The count used to come from a list of file tools (write_file, edit_file, ...).
// A file made any other way did not exist for it: ffmpeg run through
// run_command, a Python script, an MCP server writing for the agent. 20 of 28
// answers in one benchmark run ended "[Nothing was changed on disk this turn.]"
// over a file the task had just produced, and each of those turns also paid for
// a model call asking why nothing had been done.
//
// A snapshot is path -> mtime and size for every file under the roots. Two
// snapshots differ exactly where something was written, whoever wrote it.

import { readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// Past this many files a snapshot gives up and says so (null), and the caller
// makes no claim about the disk. Walking a big tree on every tool call would
// cost more than the answer is worth, and "unknown" is honest where a partial
// count would not be.
export const MAX_FILES = 20000;

// Stores that churn on their own or hold other people's code. A change there is
// not the work the operator asked for, and node_modules alone can exceed
// MAX_FILES in an ordinary project.
const SKIP_DIRS = new Set([".git", "node_modules"]);

/**
 * @param {string[]} roots - folders to read; duplicates and nesting are fine
 * @param {{maxFiles?: number, skip?: string[]}} [opts] - skip: folders not to
 *   descend into, for Flint's own state. Flint writes its session log on every
 *   step, so when it runs from its own folder that log would count as the
 *   turn's work. A root inside a skipped folder (the session workspace sits
 *   under sessions/) is still read, because it was named.
 * @returns {Map<string, string> | null} absolute path -> "mtimeMs:size", or null past maxFiles
 */
export function snapshotWorkspace(roots, { maxFiles = MAX_FILES, skip = [] } = {}) {
  const files = new Map();
  const seenDirs = new Set(skip.filter(Boolean).map((s) => resolve(s)));
  const stack = [...new Set(roots.filter(Boolean).map((r) => resolve(r)))];
  for (const r of stack) seenDirs.delete(r);
  while (stack.length) {
    const dir = stack.pop();
    if (seenDirs.has(dir)) continue;
    seenDirs.add(dir);
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // a root that does not exist yet, or a folder we may not read
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push(p);
        continue;
      }
      if (!e.isFile()) continue;
      let st;
      try {
        st = statSync(p);
      } catch {
        continue; // removed between readdir and stat
      }
      files.set(p, `${st.mtimeMs}:${st.size}`);
      if (files.size > maxFiles) return null;
    }
  }
  return files;
}

/**
 * Paths that were added, modified or removed between two snapshots.
 * @returns {string[] | null} null when either side is unknown
 */
export function changedFiles(before, after) {
  if (!before || !after) return null;
  const out = [];
  for (const [p, sig] of after) if (before.get(p) !== sig) out.push(p);
  for (const p of before.keys()) if (!after.has(p)) out.push(p);
  return out;
}

// Absolute paths in free text: a POSIX path not preceded by a URL's "//" or a
// word character, or a Windows drive path. Pseudo filesystems are left out:
// nothing the operator asked for lives there, and walking them is slow.
const POSIX_PATH = /(?<![\w:/.~-])\/(?:[\w.@%+~-]+\/?)+/g;
const WINDOWS_PATH = /\b[A-Za-z]:[\\/][^\s"'`;|&<>()*?]*/g;
const PSEUDO_FS = /^\/(proc|sys|dev)(\/|$)/;

/**
 * The folders that absolute paths in `value` point into: the path itself when
 * it is a folder, otherwise its nearest existing parent (a file the call is
 * about to create does not exist yet). Strings are read anywhere inside
 * `value`, so this does not know or care which tool the arguments belong to.
 */
export function pathRootsIn(value) {
  const strings = [];
  (function collect(v) {
    if (typeof v === "string") strings.push(v);
    else if (Array.isArray(v)) v.forEach(collect);
    else if (v && typeof v === "object") Object.values(v).forEach(collect);
  })(value);
  const roots = new Set();
  for (const s of strings) {
    for (const m of [...(s.match(POSIX_PATH) || []), ...(s.match(WINDOWS_PATH) || [])]) {
      let p = resolve(m.replace(/[\\/.,:]+$/, "") || m);
      if (PSEUDO_FS.test(p.replace(/\\/g, "/"))) continue;
      for (;;) {
        let st = null;
        try { st = statSync(p); } catch {}
        if (st?.isDirectory()) break;
        const up = dirname(p);
        if (up === p) break;
        p = up;
      }
      // The filesystem root is not a place anyone works in; reading all of it
      // would only hit MAX_FILES.
      if (dirname(p) !== p) roots.add(p);
    }
  }
  return [...roots];
}

/**
 * Follow what a turn changes. The roots named at the start (the working folder
 * and the session workspace) must be readable, or the whole answer is unknown.
 * Folders met later in arguments are read once, before the call that names
 * them runs; one too big to read is simply not watched, and not named.
 *
 * Two full readings per turn, at the start and when an answer is due, not one
 * per tool call: on an 18k-file repository a reading takes about a second on
 * Windows. The order of events (was anything run after the last change) comes
 * from the files' own times instead.
 */
export function createChangeTracker({ roots, skip = [], maxFiles = MAX_FILES }) {
  const baseline = new Map();
  const watched = new Set();
  let unknown = false;

  function watch(dirs, required) {
    for (const r of dirs.filter(Boolean).map((d) => resolve(d))) {
      if (watched.has(r)) continue;
      const snap = snapshotWorkspace([r], { skip, maxFiles });
      if (!snap) {
        if (required) unknown = true;
        continue;
      }
      watched.add(r);
      for (const [p, sig] of snap) if (!baseline.has(p)) baseline.set(p, sig);
    }
  }
  watch(roots, true);

  return {
    /** Start watching the folders any absolute path in `value` points into. */
    watchPathsIn(value) {
      watch(pathRootsIn(value), false);
    },
    /** @returns {{files: string[], newestMs: number} | null} null when unknown */
    changes() {
      if (unknown) return null;
      const now = snapshotWorkspace([...watched], { skip, maxFiles });
      const files = changedFiles(baseline, now);
      if (!files) return null;
      let newestMs = 0;
      for (const f of files) {
        const sig = now.get(f);
        if (sig) newestMs = Math.max(newestMs, parseFloat(sig));
      }
      return { files, newestMs };
    },
    roots() {
      return [...watched];
    },
  };
}
