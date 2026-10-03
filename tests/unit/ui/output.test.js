import { describe, it, expect, beforeEach, vi } from "vitest";
import chalk from "chalk";

// Force chalk colors so ANSI codes are present in test output
chalk.level = 3;

// ── Minimal store mock ──────────────────────────────────────────────
let lines;
const mockStore = {
  getState: () => ({
    addLine: (t) => lines.push(t),
    addTable: (t) => lines.push(t),
    setStreamText: () => {},
  }),
};

// We need to mock the logger before importing output.js
vi.mock("../../../src/logging/logger.js", () => ({
  createLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
}));

const {
  initOutput,
  printAgent,
  flushAgentState,
} = await import("../../../src/ui/output.js");

beforeEach(() => {
  lines = [];
  initOutput(mockStore);
});

// ── 1. printAgent — markdown rendering ──────────────────────────────
describe("printAgent", () => {
  it("renders bold text with **", () => {
    printAgent("hello **world**");
    expect(lines.some((l) => l.includes(chalk.bold("world")))).toBe(true);
  });

  it("renders bold text with __", () => {
    printAgent("hello __world__");
    expect(lines.some((l) => l.includes(chalk.bold("world")))).toBe(true);
  });

  it("renders italic text with *", () => {
    printAgent("hello *world*");
    expect(lines.some((l) => l.includes(chalk.italic("world")))).toBe(true);
  });

  it("renders italic text with _", () => {
    printAgent("hello _world_");
    expect(lines.some((l) => l.includes(chalk.italic("world")))).toBe(true);
  });

  it("renders inline code with backticks", () => {
    printAgent("run `npm test` now");
    expect(lines.some((l) => l.includes(chalk.cyan("npm test")))).toBe(true);
  });

  it("renders H1 heading as bold underline with spacing", () => {
    printAgent("# Title");
    expect(lines.some((l) => l.includes(chalk.bold.underline("Title")))).toBe(true);
    // H1 adds blank lines before and after
    expect(lines[0]).toBe("");
  });

  it("renders H2 heading as bold with blank line before", () => {
    printAgent("## Subtitle");
    expect(lines[0]).toBe("");
    expect(lines.some((l) => l.includes(chalk.bold("Subtitle")))).toBe(true);
  });

  it("renders H3 heading as bold without blank line before", () => {
    printAgent("### Minor");
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain(chalk.bold("Minor"));
  });

  it("renders unordered list items with - prefix", () => {
    printAgent("- item one");
    expect(lines.some((l) => l.includes(chalk.dim("-")))).toBe(true);
    expect(lines.some((l) => l.includes("item one"))).toBe(true);
  });

  it("renders unordered list items with * prefix", () => {
    printAgent("* starred");
    expect(lines.some((l) => l.includes("starred"))).toBe(true);
  });

  it("renders ordered list items", () => {
    printAgent("1. first");
    expect(lines.some((l) => l.includes("first"))).toBe(true);
  });

  it("renders horizontal rule", () => {
    printAgent("---");
    expect(lines.some((l) => l.includes(chalk.dim("-".repeat(40))))).toBe(true);
  });
});

// ── 2. Code block buffering with syntax highlighting ────────────────
describe("code block buffering", () => {
  it("buffers lines between ``` fences and flushes on close", () => {
    printAgent("```js");
    expect(lines).toHaveLength(0); // opening fence — buffered

    printAgent("const x = 1;");
    expect(lines).toHaveLength(0); // content — still buffered

    printAgent("```");
    // closing fence flushes: header line + highlighted code + footer
    expect(lines.length).toBeGreaterThanOrEqual(3);
    // header should mention lang
    expect(lines[0]).toContain("js");
  });

  it("captures language from opening fence", () => {
    printAgent("```python");
    printAgent("print('hi')");
    printAgent("```");
    expect(lines[0]).toContain("python");
  });

  it("falls back to 'code' label when no language specified", () => {
    printAgent("```");
    printAgent("plain");
    printAgent("```");
    expect(lines[0]).toContain("code");
  });

  it("includes highlighted code content between header and footer", () => {
    printAgent("```js");
    printAgent("const a = 42;");
    printAgent("```");
    // Middle lines (between header and footer) should contain the code text
    const contentLines = lines.slice(1, -1);
    expect(contentLines.some((l) => l.includes("42"))).toBe(true);
  });
});

// ── 3. RECENT ACTIONS stripping regex ───────────────────────────────
describe("RECENT ACTIONS stripping", () => {
  // This regex lives in agent.js but we test it in isolation
  const RECENT_ACTIONS_RE = /\[RECENT ACTIONS\][\s\S]*?(?=\n\n|\n[A-Z]|\n$|$)/;

  it("strips [RECENT ACTIONS] block followed by double newline", () => {
    const input = "before\n[RECENT ACTIONS]\nclick button\nscroll down\n\nafter";
    const result = input.replace(RECENT_ACTIONS_RE, "").trim();
    // Regex consumes up to the \n\n boundary; trim collapses outer whitespace
    expect(result).toContain("before");
    expect(result).toContain("after");
    expect(result).not.toContain("RECENT ACTIONS");
    expect(result).not.toContain("click button");
  });

  it("strips [RECENT ACTIONS] block at end of string", () => {
    const input = "before\n[RECENT ACTIONS]\nclick button";
    const result = input.replace(RECENT_ACTIONS_RE, "").trim();
    expect(result).toBe("before");
  });

  it("strips [RECENT ACTIONS] block followed by uppercase section", () => {
    const input = "[RECENT ACTIONS]\nclick button\nNEXT SECTION\nstuff";
    const result = input.replace(RECENT_ACTIONS_RE, "").trim();
    expect(result).toBe("NEXT SECTION\nstuff");
  });

  it("leaves text without [RECENT ACTIONS] unchanged", () => {
    const input = "no actions here";
    const result = input.replace(RECENT_ACTIONS_RE, "").trim();
    expect(result).toBe("no actions here");
  });
});

// ── 4. flushAgentState — flushes table and code blocks ──────────────
describe("flushAgentState", () => {
  it("flushes a pending code block", () => {
    printAgent("```js");
    printAgent("let x = 1;");
    expect(lines).toHaveLength(0);

    flushAgentState();
    // Code block header + content + footer
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(lines[0]).toContain("js");
  });

  it("flushes a pending markdown table", () => {
    printAgent("| A | B |");
    printAgent("| --- | --- |");
    printAgent("| 1 | 2 |");
    expect(lines).toHaveLength(0); // table lines are buffered

    flushAgentState();
    // Should have flushed a table object via addTable
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const table = lines.find((l) => typeof l === "object" && l.columns);
    expect(table).toBeDefined();
    expect(table.columns).toEqual(["A", "B"]);
    expect(table.rows).toEqual([["1", "2"]]);
  });

  it("is a no-op when nothing is buffered", () => {
    flushAgentState();
    expect(lines).toHaveLength(0);
  });
});

// ── 5. renderMarkdown — inline formatting (tested via printAgent) ───
describe("renderMarkdown inline formatting", () => {
  it("applies multiple inline styles in one line", () => {
    printAgent("use `cmd` with **bold** and *italic*");
    const line = lines[0];
    expect(line).toContain(chalk.cyan("cmd"));
    expect(line).toContain(chalk.bold("bold"));
    expect(line).toContain(chalk.italic("italic"));
  });

  it("does not apply italic inside words (e.g. file_name_here)", () => {
    printAgent("check file_name_here for info");
    const line = lines[0];
    // Should NOT italic-ize "name" — the underscores are mid-word
    expect(line).not.toContain(chalk.italic("name"));
    expect(line).toContain("file_name_here");
  });

  it("renders bold outside of inline code", () => {
    printAgent("normal text and **bold**");
    const line = lines[0];
    expect(line).toContain(chalk.bold("bold"));
  });
});
