// Tests for git-status.js — determining whether the working directory's git repo
// is clean at the end of a turn.
//
// The claim-vs-repo check: when a turn ran executing tools and the filesystem
// snapshot shows no changes, the turn's answer may still claim "done". The
// git status is the independent arbiter: an empty `git status --porcelain`
// means the repo was clean when the turn finished, so the claim is
// unfounded.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { gitStatusCheck, repoClaimGap } from "../../../src/agent/git-status.js";

let root;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "flint-git-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function initGit(dir) {
  // `git init` needs this set, or it uses a global that the test sandbox
  // may not have.
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "t@t.t"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "test"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "committer.email", "t@t.t"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "committer.name", "test"], { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "a.txt"), "a");
  execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });
}

describe("gitStatusCheck", () => {
  it("returns null when the dir is not a git repo", () => {
    expect(gitStatusCheck(root)).toBeNull();
  });

  it("returns { isRepo: true, clean: true } on a clean repo", () => {
    initGit(root);
    expect(gitStatusCheck(root)).toEqual({ isRepo: true, clean: true });
  });

  it("returns { isRepo: true, clean: false } when there are uncommitted changes", () => {
    initGit(root);
    writeFileSync(join(root, "b.txt"), "b");
    expect(gitStatusCheck(root)).toEqual({ isRepo: true, clean: false });
  });

  it("returns { isRepo: true, clean: false } when a file is modified", () => {
    initGit(root);
    writeFileSync(join(root, "a.txt"), "changed");
    expect(gitStatusCheck(root)).toEqual({ isRepo: true, clean: false });
  });

  it("detects clean from a subdirectory of the repo", () => {
    initGit(root);
    mkdirSync(join(root, "sub"), { recursive: true });
    expect(gitStatusCheck(join(root, "sub"))).toEqual({ isRepo: true, clean: true });
  });
});

describe("repoClaimGap", () => {
  // The truth table that finish() in agent.js now consults: the flag is true
  // only when executing tools ran, the disk snapshot found no changes, and
  // git confirms the repo was clean at finish. In that narrow window the
  // turn's answer claims work that left no trace.

  it("fires when tools ran, no files changed, and repo is clean", () => {
    expect(repoClaimGap({ toolCallsThisTurn: 4, filesChanged: [], repoClean: true })).toBe(true);
  });

  it("does not fire when no tools ran", () => {
    expect(repoClaimGap({ toolCallsThisTurn: 0, filesChanged: [], repoClean: true })).toBe(false);
  });

  it("does not fire when files did change", () => {
    expect(repoClaimGap({ toolCallsThisTurn: 4, filesChanged: ["a.js"], repoClean: true })).toBe(false);
  });

  it("does not fire when the repo is dirty", () => {
    expect(repoClaimGap({ toolCallsThisTurn: 4, filesChanged: [], repoClean: false })).toBe(false);
  });

  it("does not fire when repo status is unknown", () => {
    expect(repoClaimGap({ toolCallsThisTurn: 4, filesChanged: [], repoClean: null })).toBe(false);
  });

  it("does not fire when the snapshot was too big to read", () => {
    expect(repoClaimGap({ toolCallsThisTurn: 4, filesChanged: null, repoClean: true })).toBe(false);
  });
});
