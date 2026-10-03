// Unit tests for L4 facts + L5 user model.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { addFact, removeFact, getFacts, extractFacts, formatForPrompt as formatFacts } from "../../../src/memory/facts.js";
import { observeUser, getProfile, formatForPrompt as formatProfile } from "../../../src/memory/user-model.js";
import { closeDb, getAllFacts, getAllTraits } from "../../../src/memory/sqlite-store.js";

import { getDb } from "../../../src/memory/sqlite-store.js";

describe("facts (Layer 4)", () => {
  beforeEach(() => {
    const db = getDb();
    db.exec("DELETE FROM facts; DELETE FROM memory_fts WHERE layer='facts';");
  });

  it("addFact stores and retrieves", () => {
    const id = addFact("Project uses PostgreSQL", "environment", "user", 0.9);
    expect(id).toBeTruthy();
    const facts = getFacts("environment");
    expect(facts.some(f => f.content === "Project uses PostgreSQL")).toBe(true);
  });

  it("addFact deduplicates similar facts", () => {
    addFact("We use yarn for package management");
    const id2 = addFact("We use yarn for package management"); // exact dupe
    expect(id2).toBeNull();
  });

  it("removeFact deletes", () => {
    const id = addFact("Temp fact");
    removeFact(id);
    expect(getAllFacts().length).toBe(0);
  });

  it("extractFacts returns empty for short text (no LLM call)", async () => {
    await expect(extractFacts("hi")).resolves.toEqual([]);
    await expect(extractFacts("")).resolves.toEqual([]);
  });

  it("extractFacts skips messages without disclosure hint (no LLM call)", async () => {
    // Pure command / question with no first-person / possessive / project signal.
    // These should not trigger the LLM — pre-filter short-circuits to empty.
    await expect(extractFacts("show me the list of files")).resolves.toEqual([]);
  });

  it("formatForPrompt groups by category", () => {
    addFact("Always use strict TypeScript", "preference");
    addFact("Server port is 9090", "environment");
    const prompt = formatFacts();
    expect(prompt).toContain("[preference]");
    expect(prompt).toContain("[environment]");
    expect(prompt).toContain("§");
  });
});

describe("user-model (Layer 5)", () => {
  beforeEach(() => {
    const db = getDb();
    db.exec("DELETE FROM user_model; DELETE FROM memory_fts WHERE layer='user_model';");
  });

  it("observeUser detects script from Cyrillic message", () => {
    observeUser("Покажи мне все файлы в каталоге");
    const profile = getProfile();
    expect(profile.language?.value).toBe("cyrillic");
  });

  it("observeUser detects script from Latin message", () => {
    observeUser("show me all files in the directory");
    const profile = getProfile();
    expect(profile.language?.value).toBe("latin");
  });

  it("observeUser detects mixed scripts", () => {
    observeUser("Запусти command-line tool с parameters");
    const profile = getProfile();
    expect(profile.language?.value).toBe("cyrillic+latin");
  });

  it("observeUser detects terse style", () => {
    observeUser("покажи файлы");
    const profile = getProfile();
    expect(profile.communication_style).toBeDefined();
    expect(profile.communication_style.value).toBe("terse");
  });

  it("observeUser detects verbose style", () => {
    const longMsg = Array(60).fill("word").join(" ");
    observeUser(longMsg);
    const profile = getProfile();
    expect(profile.communication_style.value).toBe("verbose");
  });

  it("formatForPrompt filters by confidence", () => {
    observeUser("some user message with enough words for a trait");
    const prompt = formatProfile(0.3); // low threshold
    expect(prompt).toContain("§");
    const strict = formatProfile(0.99); // too strict
    expect(strict).toBe("");
  });
});
