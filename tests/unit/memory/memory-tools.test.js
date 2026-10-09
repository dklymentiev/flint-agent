import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "node:path";
import { createTmpDir } from "../../helpers/tmp-dir.js";

let tmp;
let previousDataDir;
const mockConfig = {};

vi.mock("../../../src/config.js", () => ({
  config: mockConfig,
}));

// Mock markdown to avoid side effects
vi.mock("../../../src/memory/markdown.js", () => ({
  updateMemoryMd: vi.fn(),
}));

let handlers, store;

beforeEach(async () => {
  tmp = createTmpDir();
  previousDataDir = process.env.FLINT_DATA_DIR;
  delete process.env.FLINT_DATA_DIR;
  mockConfig.projectRoot = tmp.path;
  mockConfig.sessionsDir = path.join(tmp.path, "sessions");
  vi.resetModules();
  const toolsMod = await import("../../../src/memory/tools.js");
  store = await import("../../../src/memory/store.js");
  handlers = toolsMod.handlers;
});

afterEach(() => {
  if (previousDataDir === undefined) delete process.env.FLINT_DATA_DIR;
  else process.env.FLINT_DATA_DIR = previousDataDir;
  tmp.cleanup();
});

describe("memory_write", () => {
  it("inserts memory with content, category, importance", () => {
    const result = handlers.memory_write({
      content: "User prefers dark mode",
      category: "preferences",
      importance: 2,
    });
    expect(result).toContain("Saved memory #1");
    expect(result).toContain("preferences");
    expect(result).toContain("User prefers dark mode");

    const mem = store.getMemory(1);
    expect(mem.content).toBe("User prefers dark mode");
    expect(mem.category).toBe("preferences");
    expect(mem.importance).toBe(2);
  });

  it("truncates content at max length (10000 chars)", () => {
    const longContent = "x".repeat(15000);
    handlers.memory_write({ content: longContent });
    const mem = store.getMemory(1);
    expect(mem.content.length).toBe(10000);
  });

  it("clamps importance to valid range (1-3)", () => {
    handlers.memory_write({ content: "low", importance: 0 });
    handlers.memory_write({ content: "high", importance: 99 });
    handlers.memory_write({ content: "negative", importance: -5 });

    expect(store.getMemory(1).importance).toBe(1);
    expect(store.getMemory(2).importance).toBe(3);
    expect(store.getMemory(3).importance).toBe(1);
  });

  it("defaults category to general and importance to 1", () => {
    handlers.memory_write({ content: "bare minimum" });
    const mem = store.getMemory(1);
    expect(mem.category).toBe("general");
    expect(mem.importance).toBe(1);
  });
});

describe("memory_search", () => {
  beforeEach(() => {
    handlers.memory_write({ content: "TypeScript is the main language", category: "tech", importance: 2 });
    handlers.memory_write({ content: "Deploy to staging first", category: "decisions", importance: 3 });
    handlers.memory_write({ content: "User likes concise output", category: "preferences", importance: 1 });
  });

  it("keyword search returns matching results", () => {
    const result = handlers.memory_search({ query: "TypeScript" });
    expect(result).toContain("TypeScript");
    expect(result).toContain("#1");
  });

  it("importance-weighted relevance ordering", () => {
    // Both match "deploy" or "staging", but importance 3 should score higher
    handlers.memory_write({ content: "Deploy staging config needed", category: "tech", importance: 1 });
    const result = handlers.memory_search({ query: "deploy staging" });
    // The importance=3 entry should appear first
    const lines = result.split("\n");
    expect(lines[0]).toContain("decisions");
  });

  it("limit parameter restricts result count", () => {
    handlers.memory_write({ content: "Another tech fact", category: "tech" });
    const result = handlers.memory_search({ query: "the", limit: 1 });
    const lines = result.split("\n").filter(Boolean);
    expect(lines.length).toBeLessThanOrEqual(1);
  });

  it("empty query returns no-results message", () => {
    const result = handlers.memory_search({ query: "" });
    expect(result).toContain("No memories found");
  });
});

describe("memory_get", () => {
  beforeEach(() => {
    handlers.memory_write({ content: "fact one" });
    handlers.memory_write({ content: "fact two" });
    handlers.memory_write({ content: "fact three" });
  });

  it("by ID returns correct entry", () => {
    const result = handlers.memory_get({ id: 2 });
    expect(result).toContain("#2");
    expect(result).toContain("fact two");
  });

  it("nonexistent ID returns not found", () => {
    const result = handlers.memory_get({ id: 999 });
    expect(result).toContain("not found");
  });

  it("last=N returns recent memories", () => {
    const result = handlers.memory_get({ last: 2 });
    expect(result).toContain("fact three");
    expect(result).toContain("fact two");
    expect(result).not.toContain("fact one");
  });

  it("ignores nonpositive IDs when listing recent memories", () => {
    for (const id of [0, -1]) {
      const result = handlers.memory_get({ id, last: 2 });
      expect(result).toContain("fact three");
      expect(result).toContain("fact two");
      expect(result).not.toContain("fact one");
    }
  });

  it("lists recent memories when both last and an ID are supplied", () => {
    const result = handlers.memory_get({ id: 1, last: 2 });
    expect(result).toContain("fact three");
    expect(result).toContain("fact two");
    expect(result).not.toContain("fact one");
  });
});

describe("memory_delete", () => {
  it("removes existing entry", () => {
    handlers.memory_write({ content: "to be deleted" });
    const result = handlers.memory_delete({ id: 1 });
    expect(result).toContain("Deleted");
    expect(store.getMemory(1)).toBeNull();
  });

  it("nonexistent ID returns not found", () => {
    const result = handlers.memory_delete({ id: 999 });
    expect(result).toContain("not found");
  });
});
