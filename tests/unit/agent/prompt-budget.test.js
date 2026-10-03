import { describe, it, expect } from "vitest";
import { createBudgetAllocator, estimateTokens } from "../../../src/agent/prompt-budget.js";

describe("prompt-budget allocator", () => {
  it("estimateTokens approximates chars/4", () => {
    expect(estimateTokens("hello world")).toBe(3); // 11 chars / 4 = 2.75 -> 3
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens(null)).toBe(0);
  });

  it("fixed sections are never truncated", () => {
    const alloc = createBudgetAllocator(100); // tiny budget
    alloc.addSection("core", "A".repeat(800), { priority: 1, fixed: true }); // 200 tokens
    const { prompt, stats } = alloc.build();
    expect(prompt).toBe("A".repeat(800));
    expect(stats.core.truncated).toBe(false);
  });

  it("respects min allocation for all sections", () => {
    const alloc = createBudgetAllocator(1000);
    alloc.addSection("a", "A".repeat(4000), { priority: 1, min: 500, max: 2000 }); // 1000 tokens
    alloc.addSection("b", "B".repeat(4000), { priority: 2, min: 300, max: 2000 }); // 1000 tokens
    const { stats } = alloc.build();
    // Both should get at least their min
    expect(stats.a.allocated).toBeGreaterThanOrEqual(500);
    expect(stats.b.allocated).toBeGreaterThanOrEqual(300);
  });

  it("distributes remaining budget by priority", () => {
    const alloc = createBudgetAllocator(500);
    alloc.addSection("high", "H".repeat(800), { priority: 1, min: 50, max: 300 });
    alloc.addSection("low", "L".repeat(800), { priority: 5, min: 50, max: 300 });
    const { stats } = alloc.build();
    // High priority should get more than low
    expect(stats.high.allocated).toBeGreaterThanOrEqual(stats.low.allocated);
  });

  it("truncates oversized sections with head/tail", () => {
    const alloc = createBudgetAllocator(100);
    const bigContent = "X".repeat(2000); // 500 tokens, but budget only 100
    alloc.addSection("big", bigContent, { priority: 1, min: 50, max: 100 });
    const { prompt, stats } = alloc.build();
    expect(stats.big.truncated).toBe(true);
    expect(prompt).toContain("...truncated big:");
    expect(prompt.length).toBeLessThan(bigContent.length);
  });

  it("small sections are included as-is", () => {
    const alloc = createBudgetAllocator(10000);
    alloc.addSection("small", "hello world", { priority: 1, min: 0, max: 100 });
    const { prompt, stats } = alloc.build();
    expect(prompt).toBe("hello world");
    expect(stats.small.truncated).toBe(false);
  });

  it("empty allocator returns empty", () => {
    const alloc = createBudgetAllocator(1000);
    const { prompt } = alloc.build();
    expect(prompt).toBe("");
  });

  it("preserves insertion order in output", () => {
    const alloc = createBudgetAllocator(10000);
    alloc.addSection("first", "AAA", { priority: 5, min: 0, max: 100 });
    alloc.addSection("second", "BBB", { priority: 1, min: 0, max: 100 }); // higher priority but added second
    const { prompt } = alloc.build();
    expect(prompt.indexOf("AAA")).toBeLessThan(prompt.indexOf("BBB"));
  });

  it("reports budget stats", () => {
    const alloc = createBudgetAllocator(5000);
    alloc.addSection("a", "A".repeat(400), { priority: 1, min: 0, max: 200 });
    const result = alloc.build();
    expect(result.budget).toBe(5000);
    expect(result.used).toBeGreaterThan(0);
    expect(result.remaining).toBeGreaterThan(0);
  });
});
