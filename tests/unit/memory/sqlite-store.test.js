// Unit tests for unified SQLite memory store (src/memory/sqlite-store.js).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  getDb, closeDb,
  insertReflection, getRecentReflections, getAllReflections, countReflections,
  insertPattern, getAllPatterns, countPatterns,
  insertSkill, getAllSkills, getSkill, deleteSkill,
  insertFact, getAllFacts, deleteFact,
  upsertTrait, getAllTraits,
  indexEntry, searchFts, rebuildFtsIndex,
  __internal,
} from "../../../src/memory/sqlite-store.js";

describe("sqlite-store", () => {
  beforeEach(() => {
    // Clear tables instead of deleting file (avoids EBUSY on Windows)
    const db = getDb();
    db.exec("DELETE FROM reflections; DELETE FROM patterns; DELETE FROM skills; DELETE FROM facts; DELETE FROM user_model; DELETE FROM memory_fts;");
  });

  afterEach(() => {
    // Don't close DB between tests — module keeps singleton
  });

  describe("reflections (L1)", () => {
    it("inserts and retrieves a reflection", () => {
      const id = insertReflection({
        id: "r-test-1", ts: "2026-04-16T10:00:00Z",
        did: "Fixed bug", wrong: ["missed edge case"], better: ["write test first"],
      });
      expect(id).toBe("r-test-1");
      const all = getAllReflections();
      expect(all.length).toBe(1);
      expect(all[0].did).toBe("Fixed bug");
      expect(all[0].wrong).toEqual(["missed edge case"]);
    });

    it("getRecentReflections returns newest first, limited", () => {
      insertReflection({ id: "r-1", ts: "2026-04-01T00:00:00Z", did: "first" });
      insertReflection({ id: "r-2", ts: "2026-04-02T00:00:00Z", did: "second" });
      insertReflection({ id: "r-3", ts: "2026-04-03T00:00:00Z", did: "third" });
      const recent = getRecentReflections(2);
      expect(recent.length).toBe(2);
      expect(recent[0].did).toBe("third");
      expect(recent[1].did).toBe("second");
    });

    it("countReflections returns correct count", () => {
      expect(countReflections()).toBe(0);
      insertReflection({ id: "r-x", ts: "2026-01-01T00:00:00Z", did: "x" });
      expect(countReflections()).toBe(1);
    });
  });

  describe("patterns (L2)", () => {
    it("inserts and retrieves a pattern", () => {
      insertPattern({
        id: "p-test-1", ts: "2026-04-16T10:00:00Z",
        request: "create a file", tokens: ["create", "file"],
        first_tool: "write_file", all_tools: ["write_file"], ok: true,
      });
      const all = getAllPatterns();
      expect(all.length).toBe(1);
      expect(all[0].first_tool).toBe("write_file");
      expect(all[0].tokens).toEqual(["create", "file"]);
    });
  });

  describe("skills (L3)", () => {
    it("inserts, retrieves, deletes a skill", () => {
      insertSkill({ id: "skill-test", name: "Test Skill", content: "Step 1. Step 2.", tags: ["test"] });
      const all = getAllSkills();
      expect(all.length).toBe(1);
      expect(all[0].name).toBe("Test Skill");
      expect(all[0].tags).toEqual(["test"]);

      const one = getSkill("skill-test");
      expect(one.content).toBe("Step 1. Step 2.");

      deleteSkill("skill-test");
      expect(getAllSkills().length).toBe(0);
    });
  });

  describe("facts (L4)", () => {
    it("inserts and retrieves facts", () => {
      insertFact({ id: "f-1", category: "project", content: "Uses yarn", confidence: 0.9 });
      const all = getAllFacts();
      expect(all.length).toBe(1);
      expect(all[0].content).toBe("Uses yarn");
      expect(all[0].category).toBe("project");
    });

    it("deleteFact removes entry", () => {
      insertFact({ id: "f-del", content: "temp" });
      expect(getAllFacts().length).toBe(1);
      deleteFact("f-del");
      expect(getAllFacts().length).toBe(0);
    });
  });

  describe("user_model (L5)", () => {
    it("upserts traits with confidence", () => {
      upsertTrait("language", "russian", "cyrillic detected", 0.7);
      const traits = getAllTraits();
      expect(traits.length).toBe(1);
      expect(traits[0].value).toBe("russian");

      upsertTrait("language", "mixed", "bilingual msg", 0.8);
      const updated = getAllTraits();
      expect(updated.length).toBe(1);
      expect(updated[0].value).toBe("mixed");
      expect(updated[0].confidence).toBe(0.8);
    });
  });

  describe("FTS5 search", () => {
    it("indexes and searches entries", () => {
      indexEntry("facts", "f-yarn", "We always use yarn instead of npm");
      indexEntry("facts", "f-port", "Server runs on port 8080");
      const results = searchFts("yarn npm");
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].entry_id).toBe("f-yarn");
    });

    it("filters by layer", () => {
      indexEntry("facts", "f-1", "docker compose up");
      indexEntry("skills", "s-1", "docker deployment guide");
      const factsOnly = searchFts("docker", { layer: "facts" });
      expect(factsOnly.every(r => r.layer === "facts")).toBe(true);
    });

    it("rebuildFtsIndex re-indexes all data", () => {
      insertReflection({ id: "r-fts", ts: "2026-01-01T00:00:00Z", did: "debug memory leak" });
      insertPattern({ id: "p-fts", ts: "2026-01-01T00:00:00Z", request: "find memory leak", first_tool: "search_in_files" });
      const stats = rebuildFtsIndex();
      expect(stats.indexed).toBeGreaterThan(0);
      const results = searchFts("memory leak");
      expect(results.length).toBeGreaterThan(0);
    });

    it("returns empty for empty query", () => {
      expect(searchFts("")).toEqual([]);
      expect(searchFts("   ")).toEqual([]);
    });
  });
});
