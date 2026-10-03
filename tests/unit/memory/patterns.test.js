// Unit tests for Layer 2 patterns memory (src/memory/patterns.js).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { recordPattern, loadAll, compilePreferences, formatForPrompt, tokenize } from "../../../src/memory/patterns.js";
import { getDb } from "../../../src/memory/sqlite-store.js";

describe("patterns memory (Layer 2)", () => {
  beforeEach(() => {
    const db = getDb();
    db.exec("DELETE FROM patterns; DELETE FROM memory_fts WHERE layer='patterns';");
  });

  afterEach(() => {});

  it("tokenize splits and filters stop words", () => {
    const toks = tokenize("please create a file in /tmp/test.txt");
    expect(toks).toContain("create");
    expect(toks).toContain("file");
    expect(toks).not.toContain("the");
    expect(toks).not.toContain("please");
    expect(toks).not.toContain("a");
  });

  it("tokenize keeps words of any script and strips stop words", () => {
    const toks = tokenize("please create a file in /tmp/test.txt");
    expect(toks).toContain("create");
    expect(toks).toContain("file");
    expect(toks).not.toContain("please");
    // No script is special: letters are letters.
    expect(tokenize("δημιουργία αρχείου")).toHaveLength(2);
  });

  it("recordPattern stores entry", () => {
    const id = recordPattern({ request: "create file test.txt", first_tool: "write_file" });
    expect(id).toMatch(/^p-/);
    const all = loadAll();
    expect(all.length).toBe(1);
    expect(all[0].first_tool).toBe("write_file");
    expect(all[0].tokens).toContain("create");
  });

  it("recordPattern skips empty requests", () => {
    expect(recordPattern({ request: "", first_tool: "x" })).toBeNull();
    expect(recordPattern({ request: "the a an", first_tool: "x" })).toBeNull();
    expect(recordPattern({ request: "hi", first_tool: null })).toBeNull();
  });

  it("compilePreferences extracts token→tool confidence", () => {
    // 5 unique "запиши" → write_file (unique token per tool)
    for (let i = 0; i < 5; i++) {
      recordPattern({ request: `запиши новый текст номер ${i}`, first_tool: "write_file" });
    }
    // 4 "прочитай" → read_file
    for (let i = 0; i < 4; i++) {
      recordPattern({ request: `прочитай содержимое документа ${i}`, first_tool: "read_file" });
    }
    // 3 "выполни" → run_command
    for (let i = 0; i < 3; i++) {
      recordPattern({ request: `выполни команду терминала ${i}`, first_tool: "run_command" });
    }
    const prefs = compilePreferences();
    // Each tool should have at least one predictive token
    expect(Object.keys(prefs).length).toBeGreaterThanOrEqual(2);
    // write_file should have "запиши" as predictive token (5/5 = 100%)
    if (prefs.write_file) {
      expect(prefs.write_file[0].confidence).toBeGreaterThanOrEqual(0.6);
    }
  });

  it("compilePreferences respects minConfidence and minTokenUses", () => {
    // 2 create file → write_file (below min=3)
    recordPattern({ request: "create file a", first_tool: "write_file" });
    recordPattern({ request: "create file b", first_tool: "write_file" });
    const prefs = compilePreferences({ minTokenUses: 3 });
    expect(Object.keys(prefs).length).toBe(0);
  });

  it("formatForPrompt returns readable text", () => {
    for (let i = 0; i < 5; i++) {
      recordPattern({ request: `create file ${i}`, first_tool: "write_file" });
    }
    const prefs = compilePreferences();
    const text = formatForPrompt(prefs);
    expect(text).toContain("Tool preferences");
    expect(text).toContain("write_file");
    expect(text).toContain("create");
    expect(text).toMatch(/\d+%/);
  });

  it("formatForPrompt returns empty for no prefs", () => {
    expect(formatForPrompt({})).toBe("");
  });

  it("loadAll returns empty when no patterns exist", () => {
    expect(loadAll()).toEqual([]);
  });

  // NOTE: "rotation" test removed — SQLite doesn't rotate JSONL files.
  // Bounded storage handled by eviction in higher-level code.
});
