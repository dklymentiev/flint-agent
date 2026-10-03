// Unit tests for L3 skills layer (src/memory/skills.js).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createSkill, updateSkill, removeSkill, syncFromDisk, listSkillSummaries, formatForPrompt, __internal } from "../../../src/memory/skills.js";
import { closeDb, getDb, getAllSkills } from "../../../src/memory/sqlite-store.js";

const SKILLS_DIR = __internal.SKILLS_DIR;

describe("skills (Layer 3)", () => {
  beforeEach(() => {
    // Clean DB tables
    const db = getDb();
    db.exec("DELETE FROM skills; DELETE FROM memory_fts WHERE layer='skills';");
    // Clean skills dir
    mkdirSync(SKILLS_DIR, { recursive: true });
    const files = require("node:fs").readdirSync(SKILLS_DIR);
    for (const f of files) rmSync(join(SKILLS_DIR, f));
  });

  afterEach(() => {
  });

  it("createSkill writes DB + markdown file", () => {
    const id = createSkill("Deploy flow", "Step 1: test\nStep 2: build", ["deploy"]);
    expect(id).toBe("skill-deploy-flow");

    const filePath = join(SKILLS_DIR, "deploy-flow.md");
    expect(existsSync(filePath)).toBe(true);

    const content = readFileSync(filePath, "utf-8");
    expect(content).toContain("# Deploy flow");
    expect(content).toContain("tags: deploy");

    const all = getAllSkills();
    expect(all.some(s => s.id === "skill-deploy-flow")).toBe(true);
  });

  it("updateSkill updates DB and file", () => {
    createSkill("Test skill", "Original content");
    const ok = updateSkill("skill-test-skill", "Updated content");
    expect(ok).toBe(true);

    const filePath = join(SKILLS_DIR, "test-skill.md");
    const content = readFileSync(filePath, "utf-8");
    expect(content).toContain("Updated content");
    expect(content).not.toContain("Original content");
  });

  it("removeSkill deletes DB entry and file", () => {
    createSkill("Temp skill", "Will be deleted");
    const filePath = join(SKILLS_DIR, "temp-skill.md");
    expect(existsSync(filePath)).toBe(true);

    const ok = removeSkill("skill-temp-skill");
    expect(ok).toBe(true);
    expect(existsSync(filePath)).toBe(false);
    expect(getAllSkills().length).toBe(0);
  });

  it("syncFromDisk picks up manually created files", () => {
    mkdirSync(SKILLS_DIR, { recursive: true });
    writeFileSync(join(SKILLS_DIR, "manual.md"), "---\ntags: manual\n---\n# Manual Skill\n\nDo this manually.\n");

    const result = syncFromDisk();
    expect(result.synced).toBe(1);

    const all = getAllSkills();
    expect(all.some(s => s.name === "Manual Skill")).toBe(true);
  });

  it("formatForPrompt uses progressive disclosure with §", () => {
    createSkill("Skill A", "Content A", ["tag1"]);
    createSkill("Skill B", "Content B");

    const prompt = formatForPrompt();
    expect(prompt).toContain("§ Skill A [tag1]");
    expect(prompt).toContain("§ Skill B");
    // Progressive: index with short description from first line, not full dump
    expect(prompt).toContain("load_skill"); // instructs how to get full content
  });

  it("listSkillSummaries returns id, name, tags only", () => {
    createSkill("Summary test", "Long content here", ["t1", "t2"]);
    const summaries = listSkillSummaries();
    expect(summaries[0].name).toBe("Summary test");
    expect(summaries[0].tags).toEqual(["t1", "t2"]);
    expect(summaries[0].content).toBeUndefined();
  });
});
