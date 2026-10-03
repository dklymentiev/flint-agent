import { describe, it, expect, beforeEach } from "vitest";
import { getCurrentProject, setCurrentProject, clearCurrentProject } from "../../../src/memory/project.js";

describe("project scope detection", () => {
  beforeEach(() => {
    clearCurrentProject();
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
