import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { createTmpDir } from "../../helpers/tmp-dir.js";

let tmp;
const mockConfig = {};

vi.mock("../../../src/config.js", () => ({
  config: mockConfig,
}));

let updateMemoryMd, readMemoryMdHead, store;

beforeEach(async () => {
  tmp = createTmpDir();
  mockConfig.projectRoot = tmp.path;
  mockConfig.sessionsDir = path.join(tmp.path, "sessions");
  vi.resetModules();
  store = await import("../../../src/memory/store.js");
  const md = await import("../../../src/memory/markdown.js");
  updateMemoryMd = md.updateMemoryMd;
  readMemoryMdHead = md.readMemoryMdHead;
});

afterEach(() => {
  tmp.cleanup();
});

describe("updateMemoryMd", () => {
  it("writes MEMORY.md grouped by category", () => {
    store.insertMemory({ content: "Uses Vitest", category: "tech", importance: 2 });
    store.insertMemory({ content: "Dark mode preferred", category: "preferences", importance: 1 });
    store.insertMemory({ content: "Node 20 runtime", category: "tech", importance: 3 });

    updateMemoryMd();

    const mdPath = path.join(tmp.path, "MEMORY.md");
    expect(existsSync(mdPath)).toBe(true);
    const content = readFileSync(mdPath, "utf-8");

    expect(content).toContain("# Agent Memory (3 entries)");
    expect(content).toContain("## tech (2)");
    expect(content).toContain("## preferences (1)");
    expect(content).toContain("Uses Vitest");
    expect(content).toContain("Node 20 runtime");
    expect(content).toContain("Dark mode preferred");
    // Importance stars
    expect(content).toContain("**"); // importance 2
    expect(content).toContain("***"); // importance 3
  });

  it("empty memories creates minimal file", () => {
    updateMemoryMd();

    const mdPath = path.join(tmp.path, "MEMORY.md");
    expect(existsSync(mdPath)).toBe(true);
    const content = readFileSync(mdPath, "utf-8");
    expect(content).toContain("# Agent Memory (0 entries)");
    expect(content).toContain("Last updated:");
  });
});

describe("readMemoryMdHead", () => {
  it("returns first N lines of MEMORY.md", () => {
    store.insertMemory({ content: "fact A", category: "general" });
    store.insertMemory({ content: "fact B", category: "general" });
    updateMemoryMd();

    const head = readMemoryMdHead(3);
    const lines = head.split("\n");
    expect(lines.length).toBeLessThanOrEqual(3);
    expect(lines[0]).toContain("# Agent Memory");
  });

  it("returns empty string for missing file", () => {
    const head = readMemoryMdHead(10);
    expect(head).toBe("");
  });
});
