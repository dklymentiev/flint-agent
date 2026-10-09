import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { handlers } from "../../../src/tools/filesystem";
import { createTmpDir } from "../../helpers/tmp-dir.js";
import { config } from "../../../src/config.js";
import fs from "node:fs";
import path from "node:path";

let tmp;

beforeEach(() => {
  tmp = createTmpDir();
});

afterEach(() => {
  tmp.cleanup();
});

describe("read_file", () => {
  it("reads UTF-8 text file", async () => {
    const filePath = path.join(tmp.path, "test.txt");
    fs.writeFileSync(filePath, "hello world", "utf-8");
    const result = await handlers.read_file({ path: filePath });
    expect(result).toBe("hello world");
  });

  it("returns binary message for .png", async () => {
    const filePath = path.join(tmp.path, "image.png");
    fs.writeFileSync(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const result = await handlers.read_file({ path: filePath });
    expect(result).toContain("Binary file");
    expect(result).toContain(".png");
  });

  it("returns binary message for .exe", async () => {
    const filePath = path.join(tmp.path, "app.exe");
    fs.writeFileSync(filePath, Buffer.from([0x4d, 0x5a]));
    const result = await handlers.read_file({ path: filePath });
    expect(result).toContain("Binary file");
  });

  it("returns error for non-existent file", async () => {
    await expect(
      handlers.read_file({ path: path.join(tmp.path, "nope.txt") })
    ).rejects.toThrow();
  });

  // A source file of ~1200 lines is ~60 KB, ~15k tokens: cheap. Counting in
  // lines made the tool return a 50-line preview with "ask the user about the
  // cost", and the model then read agent.js in 20-line slices.
  it("returns an ordinary source file over 1000 lines whole", async () => {
    const filePath = path.join(tmp.path, "big-source.js");
    const lines = Array.from({ length: 1500 }, (_, i) => `const line${i} = "${"x".repeat(30)}";`);
    fs.writeFileSync(filePath, lines.join("\n"), "utf-8");
    const result = await handlers.read_file({ path: filePath });
    expect(result).toContain("const line0 =");
    expect(result).toContain("const line1499 =");
    expect(result).not.toContain("FILE PREVIEW");
  });

  it("previews a file over the byte limit without asking the operator about cost", async () => {
    const filePath = path.join(tmp.path, "dump.log");
    const lines = Array.from({ length: 4000 }, (_, i) => `entry ${i} ${"y".repeat(80)}`);
    fs.writeFileSync(filePath, lines.join("\n"), "utf-8"); // ~350 KB, under the 512 KB streaming path
    const result = await handlers.read_file({ path: filePath });
    expect(result).toContain("FILE PREVIEW");
    expect(result).not.toContain("entry 3999 ");
    expect(result).not.toMatch(/Ask the user/i);
  });
});

describe("write_file", () => {
  it("creates file with content", async () => {
    const filePath = path.join(tmp.path, "new.txt");
    const result = await handlers.write_file({ path: filePath, content: "data" });
    expect(result).toContain("File written");
    expect(fs.readFileSync(filePath, "utf-8")).toBe("data");
  });

  it("creates intermediate directories", async () => {
    const filePath = path.join(tmp.path, "a", "b", "c.txt");
    await handlers.write_file({ path: filePath, content: "deep" });
    expect(fs.readFileSync(filePath, "utf-8")).toBe("deep");
  });

  it("overwrites existing file", async () => {
    const filePath = path.join(tmp.path, "existing.txt");
    fs.writeFileSync(filePath, "old", "utf-8");
    await handlers.write_file({ path: filePath, content: "new" });
    expect(fs.readFileSync(filePath, "utf-8")).toBe("new");
  });
});

describe("edit_file", () => {
  it("replaces first occurrence", async () => {
    const filePath = path.join(tmp.path, "edit.txt");
    fs.writeFileSync(filePath, "foo bar foo baz", "utf-8");
    const result = await handlers.edit_file({
      path: filePath, old_text: "foo", new_text: "qux",
    });
    expect(result).toContain("1 occurrence");
    expect(fs.readFileSync(filePath, "utf-8")).toBe("qux bar foo baz");
  });

  it("replaces all occurrences with all=true", async () => {
    const filePath = path.join(tmp.path, "edit.txt");
    fs.writeFileSync(filePath, "foo bar foo baz", "utf-8");
    const result = await handlers.edit_file({
      path: filePath, old_text: "foo", new_text: "qux", all: true,
    });
    expect(result).toContain("2 occurrence");
    expect(fs.readFileSync(filePath, "utf-8")).toBe("qux bar qux baz");
  });

  it("returns error when old_text not found", async () => {
    const filePath = path.join(tmp.path, "edit.txt");
    fs.writeFileSync(filePath, "hello", "utf-8");
    const result = await handlers.edit_file({
      path: filePath, old_text: "missing", new_text: "x",
    });
    expect(result).toContain("not found");
  });
});

describe("list_directory", () => {
  it("lists files and directories", async () => {
    fs.writeFileSync(path.join(tmp.path, "file.txt"), "");
    fs.mkdirSync(path.join(tmp.path, "subdir"));
    const result = await handlers.list_directory({ path: tmp.path });
    expect(result).toContain("file.txt");
    expect(result).toContain("subdir/");
  });
});

describe("copy_file", () => {
  it("copies file to destination", async () => {
    const src = path.join(tmp.path, "src.txt");
    const dst = path.join(tmp.path, "dst.txt");
    fs.writeFileSync(src, "copy me", "utf-8");
    const result = await handlers.copy_file({ source: src, destination: dst });
    expect(result).toContain("copied");
    expect(fs.readFileSync(dst, "utf-8")).toBe("copy me");
  });
});

describe("move_file", () => {
  it("moves file to destination", async () => {
    const src = path.join(tmp.path, "src.txt");
    const dst = path.join(tmp.path, "moved.txt");
    fs.writeFileSync(src, "move me", "utf-8");
    const result = await handlers.move_file({ source: src, destination: dst });
    expect(result).toContain("moved");
    expect(fs.existsSync(src)).toBe(false);
    expect(fs.readFileSync(dst, "utf-8")).toBe("move me");
  });
});

describe("delete_file", () => {
  it("deletes a file", async () => {
    const filePath = path.join(tmp.path, "del.txt");
    fs.writeFileSync(filePath, "bye");
    const result = await handlers.delete_file({ path: filePath });
    expect(result).toContain("deleted");
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it("deletes an empty directory", async () => {
    const dirPath = path.join(tmp.path, "emptydir");
    fs.mkdirSync(dirPath);
    const result = await handlers.delete_file({ path: dirPath });
    expect(result).toContain("deleted");
    expect(fs.existsSync(dirPath)).toBe(false);
  });
});

describe("search_in_files", () => {
  it("finds regex matches", async () => {
    fs.writeFileSync(path.join(tmp.path, "a.js"), "function hello() {}\nfunction world() {}", "utf-8");
    const result = await handlers.search_in_files({ pattern: "function \\w+", path: tmp.path });
    expect(result).toContain("function hello");
    expect(result).toContain("function world");
  });

  it("respects max_results", async () => {
    const lines = Array.from({ length: 50 }, (_, i) => `match${i}`).join("\n");
    fs.writeFileSync(path.join(tmp.path, "many.txt"), lines, "utf-8");
    const result = await handlers.search_in_files({ pattern: "match", path: tmp.path, max_results: 5 });
    expect(result).toContain("5+");
  });

  it("filters by glob", async () => {
    fs.writeFileSync(path.join(tmp.path, "a.js"), "target", "utf-8");
    fs.writeFileSync(path.join(tmp.path, "b.py"), "target", "utf-8");
    const result = await handlers.search_in_files({ pattern: "target", path: tmp.path, glob: "*.js" });
    expect(result).toContain("a.js");
    expect(result).not.toContain("b.py");
  });

  it("filters by a brace glob, the shape models actually send", async () => {
    // "*.{js,ts}" used to match nothing and answer "No matches" for
    // code that was there; the agent believed it on 2026-09-22.
    fs.writeFileSync(path.join(tmp.path, "a.js"), "target", "utf-8");
    fs.writeFileSync(path.join(tmp.path, "b.ts"), "target", "utf-8");
    fs.writeFileSync(path.join(tmp.path, "c.py"), "target", "utf-8");
    fs.mkdirSync(path.join(tmp.path, "sub"));
    fs.writeFileSync(path.join(tmp.path, "sub", "d.test.js"), "target", "utf-8");
    const result = await handlers.search_in_files({ pattern: "target", path: tmp.path, glob: "**/*.{js,ts}" });
    expect(result).toContain("a.js");
    expect(result).toContain("b.ts");
    expect(result).toContain("d.test.js");
    expect(result).not.toContain("c.py");
    const suffix = await handlers.search_in_files({ pattern: "target", path: tmp.path, glob: "*.test.js" });
    expect(suffix).toContain("d.test.js");
    expect(suffix).not.toContain("a.js");
  });

  it("refuses a glob it cannot read instead of answering No matches", async () => {
    fs.writeFileSync(path.join(tmp.path, "a.js"), "target", "utf-8");
    const result = await handlers.search_in_files({ pattern: "target", path: tmp.path, glob: "src/[ab]*" });
    expect(result).toMatch(/^Error: glob/);
  });

  it("returns message when no matches", async () => {
    fs.writeFileSync(path.join(tmp.path, "empty.txt"), "nothing here", "utf-8");
    const result = await handlers.search_in_files({ pattern: "zzzzz", path: tmp.path });
    expect(result).toContain("No matches");
  });
});

describe("view_image", () => {
  it("returns base64 data URL for png", async () => {
    const filePath = path.join(tmp.path, "test.png");
    // Minimal 1x1 red PNG
    const pngData = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
      "base64"
    );
    fs.writeFileSync(filePath, pngData);
    const result = await handlers.view_image({ path: filePath });
    expect(result).toHaveProperty("_image");
    expect(result._image).toBe(true);
    expect(result).toHaveProperty("text");
    expect(result.text).toContain("png");
  });

  it("returns error for unsupported format", async () => {
    const filePath = path.join(tmp.path, "file.txt");
    fs.writeFileSync(filePath, "not an image");
    const result = await handlers.view_image({ path: filePath });
    expect(result).toContain("unsupported");
  });
});

describe("glob", () => {
  it("finds *.js files", async () => {
    fs.writeFileSync(path.join(tmp.path, "a.js"), "");
    fs.writeFileSync(path.join(tmp.path, "b.js"), "");
    fs.writeFileSync(path.join(tmp.path, "c.txt"), "");
    const result = await handlers.glob({ pattern: "*.js", path: tmp.path });
    expect(result).toContain("a.js");
    expect(result).toContain("b.js");
    expect(result).not.toContain("c.txt");
  });

  it("finds files recursively with **/*.js", async () => {
    fs.mkdirSync(path.join(tmp.path, "sub"));
    fs.writeFileSync(path.join(tmp.path, "sub", "deep.js"), "");
    fs.writeFileSync(path.join(tmp.path, "root.js"), "");
    const result = await handlers.glob({ pattern: "**/*.js", path: tmp.path });
    expect(result).toContain("deep.js");
    expect(result).toContain("root.js");
  });

  it("returns message when no matches", async () => {
    const result = await handlers.glob({ pattern: "*.xyz", path: tmp.path });
    expect(result).toContain("No files matching");
  });
});

// On Windows, /c/... is a Git Bash shell-ism for drive C:. Node.js path.resolve
// turns /c/ into a literal "c" subdirectory of the current drive root (C:\c\...),
// so a file write at /c/Projects/x lands at C:\c\Projects\x — a different
// folder than the one run_command's bash reaches. This is the split-brain
// bug. The fix: file tools reject /drive-letter/ paths on Windows with a
// message naming the expected form, so the model corrects it in one step.
// On Linux/macOS /c/... is a real absolute path and must keep working.
describe("shell-style /drive/ paths on Windows", () => {
  const isWin = process.platform === "win32";

  it("write_file rejects /c/... path on Windows with a directive to use C:/...", async () => {
    if (!isWin) return;
    const result = await handlers.write_file({
      path: "/c/Projects/flint-work-5228/src/test-shell-path.js",
      content: "// shell path rejection test",
    });
    expect(result).toMatch(/C:\\|drive letter|expected|absolute path on Windows/);
  });

  it("read_file rejects /c/... path on Windows with a directive to use C:/...", async () => {
    if (!isWin) return;
    const result = await handlers.read_file({
      path: "/c/Projects/flint-work-5228/src/index.js",
    });
    expect(result).toMatch(/C:\\|drive letter|expected|absolute path on Windows/);
  });

  it("edit_file rejects /c/... path on Windows with a directive to use C:/...", async () => {
    if (!isWin) return;
    const result = await handlers.edit_file({
      path: "/c/Projects/flint-work-5228/src/index.js",
      old_text: "test",
      new_text: "replaced",
    });
    expect(result).toMatch(/C:\\|drive letter|expected|absolute path on Windows/);
  });

  it("list_directory rejects /c/... path on Windows", async () => {
    if (!isWin) return;
    const result = await handlers.list_directory({
      path: "/c/Projects/flint-work-5228/src",
    });
    expect(result).toMatch(/C:\\|drive letter|expected|absolute path on Windows/);
  });

  it("/c/... path works normally on Linux and macOS (not Windows)", async () => {
    if (isWin) return; // this test only asserts no regression on non-Windows
    // /c/... is a legitimate absolute path on POSIX; create it and read it back
    const dir = path.join(tmp.path, "c");
    fs.mkdirSync(path.join(dir, "sub"), { recursive: true });
    fs.writeFileSync(path.join(dir, "sub", "file.txt"), "posix content");
    const abs = path.join(tmp.path, "c");
    // On POSIX, /<tmp>/c/sub/file.txt is a real path; verify normal resolution
    const readResult = await handlers.read_file({
      path: path.join(abs, "sub", "file.txt"),
    });
    expect(readResult).toBe("posix content");
  });
});

// write_file must not create directory trees outside the project root or
// allowedPaths as a side effect of writing. Even when allowedPaths is set,
// a write to a path outside it should be refused before any directory is
// created.
describe("write_file path confinement", () => {
  it("refuses to write outside allowedPaths and creates no directory", async () => {
    const origAllowed = config.allowedPaths;
    const origProjectRoot = config.projectRoot;
    const origWorkdir = config.workdir;
    const origBaseDir = config.baseDir;

    const allowedRoot = tmp.path;
    config.allowedPaths = [allowedRoot];
    config.workdir = allowedRoot;
    config.baseDir = allowedRoot;
    config.projectRoot = allowedRoot;

    try {
      // Target a path OUTSIDE allowedRoot
      const outsideDir = path.join(tmp.path, "..", "outside-flint-test");
      const outsideFile = path.join(outsideDir, "leaked.txt");
      fs.rmSync(outsideDir, { recursive: true, force: true });

      const result = await handlers.write_file({
        path: outsideFile,
        content: "should not land here",
      });

      // Must be denied
      expect(result).toMatch(/denied|outside|Error/i);
      // Must NOT have created the directory tree
      expect(fs.existsSync(outsideFile)).toBe(false);
      expect(fs.existsSync(outsideDir)).toBe(false);
    } finally {
      config.allowedPaths = origAllowed;
      config.projectRoot = origProjectRoot;
      config.workdir = origWorkdir;
      config.baseDir = origBaseDir;
      const outsideDir = path.join(tmp.path, "..", "outside-flint-test");
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("write_file blocks write outside allowedPaths even when workdir differs from baseDir", async () => {
    // When config.workdir differs from config.baseDir, a relative write
    // path can resolve INSIDE allowedPaths via the read path (baseDir)
    // but OUTSIDE via the write path (workdir). checkAccess must check the
    // write path, not the read path, so write_file cannot create dirs
    // outside allowedPaths. The fix: checkAccess uses resolveWritePath
    // for writes (opts.forWrite).
    const origAllowed = config.allowedPaths;
    const origProjectRoot = config.projectRoot;
    const origWorkdir = config.workdir;
    const origBaseDir = config.baseDir;

    const sub = path.join(tmp.path, "sub");
    fs.mkdirSync(sub, { recursive: true });
    config.allowedPaths = [sub];          // only tmp.path/sub is allowed
    config.workdir = sub;                 // writes resolve from here
    config.baseDir = path.join(sub, "deep"); // reads resolve from here — nested inside
    config.projectRoot = sub;

    try {
      // ../escape.txt resolves to:
      //   write path (workdir=sub): tmp.path/escape.txt  — OUTSIDE allowed
      //   read path  (baseDir=sub/deep): sub/escape.txt  — INSIDE allowed
      const outsideFile = path.join(tmp.path, "escape.txt");
      fs.rmSync(outsideFile, { force: true });

      const result = await handlers.write_file({
        path: "../escape.txt",
        content: "should not land here",
      });

      expect(result).toMatch(/denied|outside/i);
      expect(fs.existsSync(outsideFile)).toBe(false);
    } finally {
      config.allowedPaths = origAllowed;
      config.projectRoot = origProjectRoot;
      config.workdir = origWorkdir;
      config.baseDir = origBaseDir;
      fs.rmSync(path.join(tmp.path, "escape.txt"), { force: true });
    }
  });

  it("create_directory rejects path outside allowedPaths when workdir differs from baseDir", async () => {
    const origAllowed = config.allowedPaths;
    const origProjectRoot = config.projectRoot;
    const origWorkdir = config.workdir;
    const origBaseDir = config.baseDir;

    const sub = path.join(tmp.path, "sub");
    const deep = path.join(sub, "deep");
    fs.mkdirSync(deep, { recursive: true });
    config.allowedPaths = [sub];
    config.workdir = sub;
    config.baseDir = deep;
    config.projectRoot = sub;

    try {
      // ../escape_dir resolves to:
      //   write path (workdir=sub): tmp.path/escape_dir  — OUTSIDE allowed
      //   read path  (baseDir=deep): sub/escape_dir     — INSIDE allowed
      const outsideDir = path.join(tmp.path, "escape_dir");
      fs.rmSync(outsideDir, { recursive: true, force: true });

      const result = await handlers.create_directory({ path: "../escape_dir" });

      expect(result).toMatch(/denied|outside/i);
      expect(fs.existsSync(outsideDir)).toBe(false);
    } finally {
      config.allowedPaths = origAllowed;
      config.projectRoot = origProjectRoot;
      config.workdir = origWorkdir;
      config.baseDir = origBaseDir;
      fs.rmSync(path.join(tmp.path, "escape_dir"), { recursive: true, force: true });
    }
  });

  it("copy_file rejects destination outside allowedPaths when workdir differs from baseDir", async () => {
    const origAllowed = config.allowedPaths;
    const origProjectRoot = config.projectRoot;
    const origWorkdir = config.workdir;
    const origBaseDir = config.baseDir;

    const sub = path.join(tmp.path, "sub");
    const deep = path.join(sub, "deep");
    fs.mkdirSync(deep, { recursive: true });
    config.allowedPaths = [sub];
    config.workdir = sub;
    config.baseDir = deep;
    config.projectRoot = sub;

    try {
      // Source is inside allowed; destination ../dest.txt resolves outside
      // via write path but inside via read path
      const srcFile = path.join(sub, "source.txt");
      fs.writeFileSync(srcFile, "data");
      const outsideFile = path.join(tmp.path, "dest.txt");
      fs.rmSync(outsideFile, { force: true });

      const result = await handlers.copy_file({
        source: "source.txt",
        destination: "../dest.txt",
      });

      expect(result).toMatch(/denied|outside/i);
      expect(fs.existsSync(outsideFile)).toBe(false);
      fs.rmSync(srcFile, { force: true });
    } finally {
      config.allowedPaths = origAllowed;
      config.projectRoot = origProjectRoot;
      config.workdir = origWorkdir;
      config.baseDir = origBaseDir;
      fs.rmSync(path.join(tmp.path, "dest.txt"), { force: true });
    }
  });

  it("move_file rejects destination outside allowedPaths when workdir differs from baseDir", async () => {
    const origAllowed = config.allowedPaths;
    const origProjectRoot = config.projectRoot;
    const origWorkdir = config.workdir;
    const origBaseDir = config.baseDir;

    const sub = path.join(tmp.path, "sub");
    const deep = path.join(sub, "deep");
    fs.mkdirSync(deep, { recursive: true });
    config.allowedPaths = [sub];
    config.workdir = sub;
    config.baseDir = deep;
    config.projectRoot = sub;

    try {
      const srcFile = path.join(sub, "source.txt");
      fs.writeFileSync(srcFile, "data");
      const outsideFile = path.join(tmp.path, "moved.txt");
      fs.rmSync(outsideFile, { force: true });

      const result = await handlers.move_file({
        source: "source.txt",
        destination: "../moved.txt",
      });

      expect(result).toMatch(/denied|outside/i);
      expect(fs.existsSync(outsideFile)).toBe(false);
      // Source should still exist (move was blocked)
      expect(fs.existsSync(srcFile)).toBe(true);
      fs.rmSync(srcFile, { force: true });
    } finally {
      config.allowedPaths = origAllowed;
      config.projectRoot = origProjectRoot;
      config.workdir = origWorkdir;
      config.baseDir = origBaseDir;
      fs.rmSync(path.join(tmp.path, "moved.txt"), { force: true });
    }
  });

  it("read_file still finds a relative path that exists only under the old read base", async () => {
    const saved = { allowedPaths: config.allowedPaths, projectRoot: config.projectRoot, workdir: config.workdir, baseDir: config.baseDir };
    const root = tmp.path;
    config.allowedPaths = [root];
    config.workdir = path.join(root, "workspace");
    config.baseDir = path.join(root, "project");
    config.projectRoot = config.baseDir;
    try {
      fs.mkdirSync(config.workdir, { recursive: true });
      fs.mkdirSync(config.baseDir, { recursive: true });
      fs.writeFileSync(path.join(config.baseDir, "notes.txt"), "from the project", "utf-8");
      const result = await handlers.read_file({ path: "notes.txt" });
      expect(result).toBe("from the project");
    } finally {
      Object.assign(config, saved);
    }
  });

  it("read_file does not leave the allowed paths through the old read base", async () => {
    const saved = { allowedPaths: config.allowedPaths, projectRoot: config.projectRoot, workdir: config.workdir, baseDir: config.baseDir };
    const root = tmp.path;
    config.allowedPaths = [path.join(root, "workspace")];
    config.workdir = path.join(root, "workspace");
    config.baseDir = path.join(root, "project");
    config.projectRoot = config.baseDir;
    try {
      fs.mkdirSync(config.workdir, { recursive: true });
      fs.mkdirSync(config.baseDir, { recursive: true });
      fs.writeFileSync(path.join(root, "secret.txt"), "outside", "utf-8");
      await expect(handlers.read_file({ path: path.join(root, "secret.txt") })).rejects.toThrow();
    } finally {
      Object.assign(config, saved);
    }
  });

  it("write_file reports the absolute path it wrote", async () => {
    const saved = { allowedPaths: config.allowedPaths, workdir: config.workdir };
    config.allowedPaths = [tmp.path];
    config.workdir = tmp.path;
    try {
      const result = await handlers.write_file({ path: "data.csv", content: "a,b" });
      expect(result).toBe("File written: " + path.resolve(tmp.path, "data.csv"));
    } finally {
      Object.assign(config, saved);
    }
  });

  it("write_file and read_file resolve the same relative path to the same location", async () => {
    // Reproduces the bug: write_file resolves relative to workdir,
    // read_file resolves relative to baseDir/projectRoot. When these differ,
    // a file written as "sub/test.txt" can't be read back.
    const origProjectRoot = config.projectRoot;
    const origWorkdir = config.workdir;
    const origBaseDir = config.baseDir;
    const origAllowed = config.allowedPaths;

    const allowedRoot = tmp.path;
    config.allowedPaths = [allowedRoot];
    config.workdir = path.join(allowedRoot, "workspace");
    config.baseDir = allowedRoot;
    config.projectRoot = allowedRoot;

    try {
      fs.mkdirSync(config.workdir, { recursive: true });
      const relPath = "sub/test.txt";

      const writeResult = await handlers.write_file({ path: relPath, content: "hello" });
      expect(writeResult).not.toMatch(/Error|denied/i);

      // The file should be at the workdir location (where write_file put it)
      const writeLoc = path.resolve(config.workdir, relPath);
      expect(fs.existsSync(writeLoc)).toBe(true);

      // read_file with the same relative path should find it
      const readResult = await handlers.read_file({ path: relPath });
      expect(readResult).toContain("hello"); // ← RED before fix: file not found
    } finally {
      config.allowedPaths = origAllowed;
      config.projectRoot = origProjectRoot;
      config.workdir = origWorkdir;
      config.baseDir = origBaseDir;
    }
  });
});
