// Tests for claim-vs-repo: gitStatusCheck accepts a work-dir parameter,
// and repoClaimGap correctly handles filesChanged as an array.

import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { gitStatusCheck, repoClaimGap } from "../../../src/agent/git-status.js";

function initGit(dir) {
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "t@t.t"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "test"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "committer.email", "t@t.t"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "committer.name", "test"], { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "a.txt"), "a");
  execFileSync("git", ["-C", dir, "add", "."], { stdio: "ignore" });
  execFileSync("git", ["-C", dir, "commit", "-m", "initial"], { stdio: "ignore" });
}

describe("repoClaimGap with array filesChanged", () => {
  it("returns false when filesChanged is a non-empty array (changes happened)", () => {
    // RED: current code does `filesChanged > 0` which is NaN > 0 → false,
    // so the guard doesn't trigger, and repoClean truthy → returns true incorrectly.
    const gap = repoClaimGap({ toolCallsThisTurn: 1, filesChanged: ["a.js"], repoClean: true });
    expect(gap).toBe(false);
  });

  it("returns false when filesChanged is null (snapshot too big)", () => {
    const gap = repoClaimGap({ toolCallsThisTurn: 1, filesChanged: null, repoClean: true });
    expect(gap).toBe(false);
  });

  it("returns true when tools ran, filesChanged is [], and repo is clean", () => {
    const gap = repoClaimGap({ toolCallsThisTurn: 1, filesChanged: [], repoClean: true });
    expect(gap).toBe(true);
  });

  it("returns false when no tools ran", () => {
    const gap = repoClaimGap({ toolCallsThisTurn: 0, filesChanged: [], repoClean: true });
    expect(gap).toBe(false);
  });

  it("does not fire when repo is not clean", () => {
    const gap = repoClaimGap({ toolCallsThisTurn: 1, filesChanged: [], repoClean: false });
    expect(gap).toBe(false);
  });

  it("does not fire when repo is not a git repo (repoClean is null)", () => {
    const gap = repoClaimGap({ toolCallsThisTurn: 1, filesChanged: [], repoClean: null });
    expect(gap).toBe(false);
  });
});

describe("gitStatusCheck work directory", () => {
  it("checks the directory passed as argument, not process.cwd", () => {
    const workDir = mkdtempSync(join(tmpdir(), "task-work-"));
    initGit(workDir);
    writeFileSync(join(workDir, "changed.txt"), "changed");

    const status = gitStatusCheck(workDir);
    expect(status).not.toBeNull();
    expect(status.isRepo).toBe(true);
    expect(status.clean).toBe(false);
    rmSync(workDir, { recursive: true, force: true });
  });

  it("returns null for non-git directory", () => {
    const notGit = mkdtempSync(join(tmpdir(), "not-git-"));
    const status = gitStatusCheck(notGit);
    expect(status).toBeNull();
    rmSync(notGit, { recursive: true, force: true });
  });
});

import { canChangeWorkspace } from "../../../src/agent/git-status.js";

describe("canChangeWorkspace", () => {
  const wd = resolve("proj-repo");
  const outside = resolve(wd, "..", "elsewhere", "x.txt");
  it("reads and searches cannot change the workspace", () => {
    for (const n of ["read_file", "glob", "search_in_files", "list_directory", "web_fetch", "think"]) {
      expect(canChangeWorkspace(n, { path: "a.js" }, wd)).toBe(false);
    }
  });
  it("file writes inside the tree count, outside do not", () => {
    expect(canChangeWorkspace("write_file", { path: "src/a.js" }, wd)).toBe(true);
    expect(canChangeWorkspace("write_file", { path: outside }, wd)).toBe(false);
    expect(canChangeWorkspace("move_file", { source: outside, destination: "b.js" }, wd)).toBe(true);
  });
  it("shell commands count, a lone ssh does not", () => {
    expect(canChangeWorkspace("run_command", { command: "npm test" }, wd)).toBe(true);
    expect(canChangeWorkspace("run_command", { command: "ssh node 'sudo systemctl restart x'" }, wd)).toBe(false);
    expect(canChangeWorkspace("run_command", { command: "ssh node ls > out.txt" }, wd)).toBe(true);
  });
  // write_file's real arguments are { files: [{ path, content }] }: no path
  // argument at the top level. A file tool whose target cannot be read off its
  // arguments must count as able to change the repo, or the tool that writes
  // most of the files would never make a gap.
  it("a file tool with no recognisable target counts", () => {
    expect(canChangeWorkspace("write_file", { files: [{ path: "src/a.js", content: "x" }] }, wd)).toBe(true);
    expect(canChangeWorkspace("delete_file", {}, wd)).toBe(true);
    expect(canChangeWorkspace("edit_file", undefined, wd)).toBe(true);
  });
});
