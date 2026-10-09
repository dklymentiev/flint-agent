import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createTmpDir } from "../../helpers/tmp-dir.js";

const mockConfig = {};
vi.mock("../../../src/config.js", () => ({ config: mockConfig }));

let tmp;
let previousDataDir;

beforeEach(() => {
  tmp = createTmpDir();
  previousDataDir = process.env.FLINT_DATA_DIR;
  mockConfig.projectRoot = path.join(tmp.path, "app");
  vi.resetModules();
});

afterEach(() => {
  if (previousDataDir === undefined) delete process.env.FLINT_DATA_DIR;
  else process.env.FLINT_DATA_DIR = previousDataDir;
  tmp.cleanup();
});

describe("memory data directory", () => {
  it("keeps memories and the markdown index under FLINT_DATA_DIR", async () => {
    const dataDir = path.join(tmp.path, "agent-data");
    process.env.FLINT_DATA_DIR = dataDir;
    const store = await import("../../../src/memory/store.js");
    const markdown = await import("../../../src/memory/markdown.js");

    store.insertMemory({ content: "An isolated fact" });
    markdown.updateMemoryMd();

    expect(readFileSync(path.join(dataDir, "memory", "memories.jsonl"), "utf-8"))
      .toContain("An isolated fact");
    expect(readFileSync(path.join(dataDir, "MEMORY.md"), "utf-8"))
      .toContain("An isolated fact");
    expect(existsSync(path.join(mockConfig.projectRoot, "memory"))).toBe(false);
    expect(existsSync(path.join(mockConfig.projectRoot, "MEMORY.md"))).toBe(false);
  });

  it("preserves the project paths when FLINT_DATA_DIR is unset", async () => {
    delete process.env.FLINT_DATA_DIR;
    const store = await import("../../../src/memory/store.js");
    const markdown = await import("../../../src/memory/markdown.js");

    store.insertMemory({ content: "A local fact" });
    markdown.updateMemoryMd();

    expect(existsSync(path.join(mockConfig.projectRoot, "memory", "memories.jsonl")))
      .toBe(true);
    expect(existsSync(path.join(mockConfig.projectRoot, "MEMORY.md")))
      .toBe(true);
  });
});
