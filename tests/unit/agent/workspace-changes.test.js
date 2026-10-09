// What a turn changed, read off the folders rather than off tool names.
//
// In a benchmark run, a file made by ffmpeg through run_command did not exist for the old
// count, so 20 of 28 answers said nothing had changed. These run on real files.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { snapshotWorkspace, changedFiles, pathRootsIn, createChangeTracker } from "../../../src/agent/workspace-changes.js";

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

describe("path confinement in change tracking", () => {
  it("pathRootsIn rejects shell-style /drive/ paths on Windows", async () => {
    // On Windows, /c/... is a Git Bash shell-ism. pathRootsIn must not
    // treat it as a real path — it resolves to C:\c\... which is a different
    // folder from the intended C:\Projects\...
    if (process.platform !== "win32") return;

    const roots = pathRootsIn({
      text: "/c/Projects/flint-work-5228/src/index.js",
    });
    // No roots should be extracted from the shell-style path
    expect(roots.length).toBe(0);
  });

  it("changes() does not track split-brain paths from model text", async () => {
    // Simulates the actual bug: the model's text contains a /c/... path,
    // which pathRootsIn would resolve to C:\c\... (a different folder).
    // The tracker should not watch that folder, so changes there don't
    // appear in the turn footer.
    if (process.platform !== "win32") return;

    const { config } = await import("../../../src/config.js");
    const origProjectRoot = config.projectRoot;

    const projectDir = root;
    config.projectRoot = projectDir;

    // The /c/... path resolves to a folder on drive C — compute what it
    // resolves to so we can write in it if the fix is missing
    const { resolve } = await import("node:path");
    const foreignPath = resolve("/c/flint-split-brain-test/sub");
    rmSync(foreignPath, { recursive: true, force: true });
    mkdirSync(foreignPath, { recursive: true });

    try {
      const tracker = createChangeTracker({ roots: [projectDir] });
      // Simulate the model's text containing a /c/... shell-style path.
      // pathRootsIn should reject it, so the tracker should NOT watch
      // C:\c\flint-split-brain-test\sub
      tracker.watchPathsIn({ text: "/c/flint-split-brain-test/sub/file.txt" });

      // Write in the project
      writeFileSync(join(projectDir, "changed.txt"), "legit");
      // Write in the foreign dir (what pathRootsIn would have watched)
      writeFileSync(join(foreignPath, "foreign.txt"), "foreign change");

      const changes = tracker.changes();
      expect(changes).not.toBeNull();
      expect(changes.files).toContain(join(projectDir, "changed.txt"));
      // The foreign file must NOT appear — /c/... should not have been watched
      expect(changes.files).not.toContain(join(foreignPath, "foreign.txt"));
    } finally {
      config.projectRoot = origProjectRoot;
      rmSync(foreignPath, { recursive: true, force: true });
    }
  });
});
