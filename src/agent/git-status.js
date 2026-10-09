// git-status.js — determine whether the working directory's git repository
// is clean at the end of a turn.
//
// The claim-vs-repo check: a turn's answer can claim "done" while the
// filesystem snapshot shows no changes and no tool ran. `git status
// --porcelain` is the independent arbiter — an empty result means the repo
// was clean when the turn finished, so the claim is unfounded.
//
// Returns null when the directory is not a git repo, or when git itself is
// unavailable — in both cases the caller must not assert anything about the
// repo state.

import { execFileSync } from "node:child_process";
import path from "node:path";

// Tools that can change the workspace. A read (read_file, glob, search, ...) or
// a plan/task/memory call leaves no trace by design, so a clean repo after it
// says nothing about a claim. Anything not named here is NOT evidence of work:
// a missed flag costs a footer line, a false flag tells the operator the agent
// lied about a turn that only read files.
const FILE_MUTATING_TOOLS = new Set(["write_file", "edit_file", "delete_file", "move_file", "copy_file", "create_directory"]);
const COMMAND_TOOLS = new Set(["run_command", "run_background_command", "desktop_shell"]);
// Argument names that carry a path a file tool will write to.
const PATH_ARGS = ["path", "file_path", "file", "destination", "dest", "to", "target", "new_path"];

function insideDir(file, dir) {
  const rel = path.relative(path.resolve(dir), path.resolve(dir, String(file)));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Can this call have changed the repo at `workdir`?
 *
 * File tools: only when a path they write to is inside the work tree. A write
 * to /tmp is real work but not a claim about this repo. Shell tools could do
 * anything, so they count, except a lone `ssh ...` (remote deploy): it runs
 * elsewhere and writes locally only through a shell redirect.
 */
export function canChangeWorkspace(name, args, workdir) {
  if (FILE_MUTATING_TOOLS.has(name)) {
    const targets = PATH_ARGS.map((k) => args?.[k]).filter((v) => typeof v === "string" && v);
    if (!targets.length) return true;
    return targets.some((t) => insideDir(t, workdir));
  }
  if (COMMAND_TOOLS.has(name)) {
    const cmd = String(args?.command ?? "").trim();
    // Conservative: any redirect, chain, pipe or newline might do local work too.
    if (/^ssh\s/.test(cmd) && !/[>;&|\r\n]/.test(cmd)) return false;
    return true;
  }
  return false;
}

/**
 * Check whether `dir` is inside a git repository and whether the working
 * tree is clean.
 *
 * @param {string} dir — the directory to check (the task work directory,
 *   config.workdir, NOT process.cwd() which is the Flint launch dir)
 * @returns {{ isRepo: boolean, clean: boolean } | null}
 *   - null: not a git repo, or git is unavailable
 *   - { isRepo: true, clean: true }: repo, no uncommitted changes
 *   - { isRepo: true, clean: false }: repo, has uncommitted changes
 */
export function gitStatusCheck(dir) {
  try {
    const out = execFileSync("git", ["-C", dir, "status", "--porcelain"], {
      encoding: "utf-8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { isRepo: true, clean: (out || "").trim() === "" };
  } catch (err) {
    // Non-zero exit from `git status` means the directory is not inside a
    // git repo (or git is not installed — 127). Either way we cannot
    // assert anything about repo cleanliness.
    const code = err?.status ?? err?.code;
    if (code === 128 || code === "ENOENT" || code === 127) return null;
    // A timeout or other unexpected error: treat as "cannot determine".
    return null;
  }
}

/**
 * Returns true when the turn's claim-vs-repo condition holds: executing tools
 * ran, the filesystem snapshot shows no changes, and the git repo is clean.
 * In that situation the turn's answer claims work that left no trace, so the
 * footer and API response should be flagged.
 *
 * @param {object} turn — { filesChanged, toolCallsMade, repoClean }
 * @returns {boolean}
 */
export function repoClaimGap(turn = {}) {
  const { toolCallsThisTurn = 0, filesChanged, repoClean } = turn;
  // toolCallsThisTurn === 0  → nothing ran, no claim to check
  // filesChanged is null     → snapshot was too big to read, cannot assert
  // filesChanged.length > 0  → real changes happened, no gap
  // The array check matters: `filesChanged > 0` coerces ["a"] to NaN > 0 →
  // false, so the guard never fired and a turn that DID change files still got
  // flagged when the repo was clean (changes outside the repo, or in .gitignore).
  if (toolCallsThisTurn === 0) return false;
  if (filesChanged === null) return false;
  if (Array.isArray(filesChanged) && filesChanged.length > 0) return false;
  if (repoClean !== true) return false;
  return true;
}
