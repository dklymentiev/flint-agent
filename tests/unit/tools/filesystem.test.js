import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { handlers } from "../../../src/tools/filesystem.js";
import { createTmpDir } from "../../helpers/tmp-dir.js";
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
