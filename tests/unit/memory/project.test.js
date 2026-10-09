import { describe, it, expect, beforeEach } from "vitest";
import { getCurrentProject, setCurrentProject, clearCurrentProject } from "../../../src/memory/project.js";
import { config } from "../../../src/config.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("project scope detection", () => {
  beforeEach(() => {
    clearCurrentProject();
  });

  it("detects the project from the folder the agent works in, not from Flint's own folder", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flint-proj-"));
    const saved = config.baseDir;
    try {
      fs.writeFileSync(path.join(dir, "MEMORY.md"), "project: zz-demo" + String.fromCharCode(10) + "notes", "utf-8");
      config.baseDir = dir;
      expect(getCurrentProject()).toBe("zz-demo");
    } finally {
      config.baseDir = saved;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null when no override and unknown CWD", () => {
    expect(getCurrentProject("/tmp")).toBe(null);
  });

  it("honors explicit override", () => {
    setCurrentProject("flint");
    expect(getCurrentProject("/tmp")).toBe("flint");
  });

  it("normalises explicit name to lowercase", () => {
    setCurrentProject("Flint");
    expect(getCurrentProject()).toBe("flint");
  });

  it("clearCurrentProject drops override", () => {
    setCurrentProject("flint");
    clearCurrentProject();
    expect(getCurrentProject("/tmp")).toBe(null);
  });

  it("ignores generic leaf directories", () => {
    expect(getCurrentProject("/home/user/src")).toBe(null);
    expect(getCurrentProject("/home/user/tmp")).toBe(null);
    expect(getCurrentProject("/home/user/desktop")).toBe(null);
  });

  it("detects project from CWD leaf name", () => {
    // 'flint-agent' leaf → strips -agent suffix → "flint"
    expect(getCurrentProject("/some/path/flint-agent")).toBe("flint");
    // generic project name
    expect(getCurrentProject("/some/path/mesh")).toBe("mesh");
  });

  it("strips common suffixes", () => {
    expect(getCurrentProject("/p/myapp-app")).toBe("myapp");
    expect(getCurrentProject("/p/mysite-site")).toBe("mysite");
  });
});
