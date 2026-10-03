// Tests for Knowledge Store
//
// Isolated on purpose. This file used to write into the repository's real
// knowledge/facts.jsonl -- the same file the running agent learns into. By
// 2026-09-20 that file held 264 entries, and "stores and retrieves a pattern"
// started failing because a fact the agent had learned outranked the pattern
// the test had just stored. The assertions were fine; they were reading a
// shared, growing file that the product writes to at runtime.
import { describe, it, expect, vi, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// knowledge.js resolves its directory as config.sessionsDir/../knowledge at
// import time, so the mock has to be in place before the module is imported.
const tmp = vi.hoisted(() => {
  const nodeFs = require("node:fs");
  const nodePath = require("node:path");
  const nodeOs = require("node:os");
  return { base: nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "knowledge-test-")) };
});

vi.mock("../../../src/config.js", () => ({
  config: { sessionsDir: path.join(tmp.base, "sessions") },
}));

const { store, retrieve, formatForPrompt } = await import("../../../src/agent/knowledge.js");

afterAll(() => {
  fs.rmSync(tmp.base, { recursive: true, force: true });
});

describe("knowledge store", () => {
  it("writes to its own directory, not the repository's", () => {
    store({ type: "fact", text: "isolation probe", context: "test", triggers: ["isolation"] });
    const file = path.join(tmp.base, "knowledge", "facts.jsonl");
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.readFileSync(file, "utf-8")).toContain("isolation probe");
  });

  it("stores and retrieves a fact", () => {
    store({
      type: "fact",
      text: "Use desktop_shell for remote file creation",
      context: "remote file ops",
      triggers: ["remote", "file", "shell"],
    });
    const results = retrieve("remote file creation");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].text).toContain("desktop_shell");
  });

  it("stores and retrieves a pattern", () => {
    store({
      type: "pattern",
      text: "For web search: navigate → search → page_read → save",
      context: "web research",
      triggers: ["search", "web", "save", "recipe"],
    });
    const results = retrieve("search web for recipe");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].type).toBe("pattern");
  });

  it("returns empty for no match", () => {
    const results = retrieve("quantum physics entanglement");
    // May return 0 or low-score results
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it("formatForPrompt returns null for empty", () => {
    expect(formatForPrompt([])).toBeNull();
  });

  it("formatForPrompt formats entries", () => {
    const entries = [
      { type: "fact", text: "test fact" },
      { type: "pattern", text: "test pattern" },
    ];
    const formatted = formatForPrompt(entries);
    expect(formatted).toContain("[KNOWLEDGE");
    expect(formatted).toContain("[fact]");
    expect(formatted).toContain("[pattern]");
  });
});
