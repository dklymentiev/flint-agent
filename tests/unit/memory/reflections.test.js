// Unit tests for Layer 1 reflections memory (src/memory/reflections.js).
// Updated 2026-04-17: backend migrated from JSONL to SQLite.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { appendReflection, loadRecent, loadAll, formatForPrompt } from "../../../src/memory/reflections.js";
import { getDb } from "../../../src/memory/sqlite-store.js";

describe("reflections memory (Layer 1)", () => {
  beforeEach(() => {
    // Clean reflections table for each test
    const db = getDb();
    db.exec("DELETE FROM reflections; DELETE FROM memory_fts WHERE layer='reflections';");
  });

  afterEach(() => {});

  it("appendReflection creates the file and stores one entry", () => {
    const id = appendReflection({
      session_id: "s1",
      did: "ran benchmark",
      wrong: ["was too verbose"],
      better: ["keep answers short"],
      tags: ["verbosity"],
    });
    expect(id).toMatch(/^r-/);
    const all = loadAll();
    expect(all.length).toBe(1);
    expect(all[0].did).toBe("ran benchmark");
    expect(all[0].wrong).toEqual(["was too verbose"]);
    expect(all[0].better).toEqual(["keep answers short"]);
    expect(all[0].tags).toEqual(["verbosity"]);
  });

  it("appendReflection discards empty reflections", () => {
    const id = appendReflection({ did: "", wrong: [], better: [] });
    expect(id).toBeNull();
  });

  it("loadRecent returns entries newest-first", () => {
    appendReflection({ session_id: "s1", did: "first", wrong: ["w1"], better: ["b1"] });
    appendReflection({ session_id: "s2", did: "second", wrong: ["w2"], better: ["b2"] });
    appendReflection({ session_id: "s3", did: "third", wrong: ["w3"], better: ["b3"] });
    const recent = loadRecent(2);
    expect(recent.length).toBe(2);
    expect(recent[0].did).toBe("third");
    expect(recent[1].did).toBe("second");
  });

  it("loadRecent handles missing file", () => {
    const recent = loadRecent(5);
    expect(recent).toEqual([]);
  });

  // NOTE: "loadAll skips malformed lines" test removed — SQLite doesn't have malformed lines.
  // Data integrity guaranteed by database schema.

  it("formatForPrompt produces readable text", () => {
    appendReflection({
      session_id: "s1",
      did: "debugged an issue",
      wrong: ["missed the actual error line", "fixed the wrong file"],
      better: ["read error message first", "verify file path before editing"],
      tags: ["debugging"],
    });
    const recent = loadRecent(1);
    const text = formatForPrompt(recent);
    expect(text).toContain("Past lessons");
    expect(text).toContain("I did wrong");
    expect(text).toContain("missed the actual error line");
    expect(text).toContain("Next time");
    expect(text).toContain("read error message first");
  });

  it("formatForPrompt returns empty string for empty list", () => {
    expect(formatForPrompt([])).toBe("");
  });

  it("formatForPrompt caps items at 3 per section", () => {
    appendReflection({
      session_id: "s1",
      did: "many issues",
      wrong: ["one", "two", "three", "four", "five"],
      better: ["a", "b", "c", "d", "e"],
    });
    const text = formatForPrompt(loadRecent(1));
    expect(text).toContain("one");
    expect(text).toContain("three");
    expect(text).not.toContain("four"); // only first 3 included
    expect(text).not.toContain("five");
  });

  // NOTE: "rotation" test removed — SQLite doesn't rotate JSONL files.
  // Bounded storage handled by eviction in higher-level code.
});
