// What a turn changed, read off the folders rather than off tool names.
//
// In a benchmark run, a file made by ffmpeg through run_command did not exist for the old
// count, so 20 of 28 answers said nothing had changed. These run on real files.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { snapshotWorkspace, changedFiles } from "../../../src/agent/workspace-changes.js";

let root;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "flint-ws-"));
  writeFileSync(join(root, "keep.txt"), "a");
  writeFileSync(join(root, "edit.txt"), "a");
  writeFileSync(join(root, "gone.txt"), "a");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("changes read off the folder", () => {
  it("sees a file written by a separate process, not by a file tool", () => {
    const before = snapshotWorkspace([root]);
    execFileSync(process.execPath, ["-e", `require("fs").writeFileSync(${JSON.stringify(join(root, "made.mp3"))}, "x")`]);
    expect(changedFiles(before, snapshotWorkspace([root]))).toEqual([join(root, "made.mp3")]);
  });

  it("sees an edit, an addition and a removal, and nothing else", () => {
    const before = snapshotWorkspace([root]);
    writeFileSync(join(root, "edit.txt"), "ab");
    writeFileSync(join(root, "new.txt"), "n");
    rmSync(join(root, "gone.txt"));
    expect(changedFiles(before, snapshotWorkspace([root])).sort()).toEqual(
      [join(root, "edit.txt"), join(root, "gone.txt"), join(root, "new.txt")].sort(),
    );
  });

  it("sees a same-size rewrite through its time", () => {
    const before = snapshotWorkspace([root]);
    writeFileSync(join(root, "edit.txt"), "b");
    const later = new Date(Date.now() + 5000);
    utimesSync(join(root, "edit.txt"), later, later);
    expect(changedFiles(before, snapshotWorkspace([root]))).toEqual([join(root, "edit.txt")]);
  });

  it("reports no change when nothing was written", () => {
    const before = snapshotWorkspace([root]);
    expect(changedFiles(before, snapshotWorkspace([root]))).toEqual([]);
  });

  it("does not count Flint's own state, but reads a root placed inside it", () => {
    // Flint writes its session log on every step. The session workspace lives
    // under sessions/ and is a root of its own.
    const sessions = join(root, "sessions");
    const workspace = join(sessions, "s1", "workspace");
    mkdirSync(workspace, { recursive: true });
    const before = snapshotWorkspace([root, workspace], { skip: [sessions] });
    writeFileSync(join(sessions, "s1.log"), "step");
    writeFileSync(join(workspace, "out.txt"), "made");
    expect(changedFiles(before, snapshotWorkspace([root, workspace], { skip: [sessions] }))).toEqual([join(workspace, "out.txt")]);
  });

  it("gives up rather than guessing past the file limit", () => {
    expect(snapshotWorkspace([root], { maxFiles: 2 })).toBeNull();
    expect(changedFiles(null, snapshotWorkspace([root]))).toBeNull();
  });

  it("skips .git and node_modules", () => {
    mkdirSync(join(root, ".git"));
    mkdirSync(join(root, "node_modules"));
    const before = snapshotWorkspace([root]);
    writeFileSync(join(root, ".git", "index"), "x");
    writeFileSync(join(root, "node_modules", "p.js"), "x");
    expect(changedFiles(before, snapshotWorkspace([root]))).toEqual([]);
  });
});
