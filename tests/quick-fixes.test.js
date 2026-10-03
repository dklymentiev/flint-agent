import { describe, it, expect } from "vitest";

// ============================================================
// Filter RECENT ACTIONS from tool results
// ============================================================
describe("Filter RECENT ACTIONS", () => {
  // Simulate the filtering logic from agent.js
  function filterRecentActions(result) {
    return String(result).replace(/\[RECENT ACTIONS\][\s\S]*?(?=\n\n|\n[A-Z]|\n$|$)/, "").trim();
  }

  it("strips [RECENT ACTIONS] block from screenshot result", () => {
    const input = `Grid: 10x6. Cells are numbered on the image.
NEXT STEP: Pick a cell number and call desktop_look(cell=N).

[RECENT ACTIONS]
  05:08:47.358 desktop_key(keys="Super_L") 447ms
  05:08:49.634 desktop_type(length=7) 424ms
  05:08:50.866 desktop_key(keys="Return") 385ms

Some other text after`;

    const filtered = filterRecentActions(input);
    expect(filtered).not.toContain("[RECENT ACTIONS]");
    expect(filtered).not.toContain("desktop_key");
    expect(filtered).toContain("Grid: 10x6");
    expect(filtered).toContain("NEXT STEP");
  });

  it("leaves result unchanged when no RECENT ACTIONS", () => {
    const input = "Grid: 10x6. Cells are numbered.\nNEXT STEP: Pick a cell.";
    const filtered = filterRecentActions(input);
    expect(filtered).toBe(input);
  });

  it("handles RECENT ACTIONS at end of string", () => {
    const input = `Grid: 10x6.\n\n[RECENT ACTIONS]\n  05:00:00 desktop_screenshot 500ms`;
    const filtered = filterRecentActions(input);
    expect(filtered).not.toContain("[RECENT ACTIONS]");
    expect(filtered).toContain("Grid: 10x6.");
  });
});

// ============================================================
// Escape spam — don't show [Aborted] when nothing running
// ============================================================
describe("Escape abort spam", () => {
  it("handleAbort does nothing when abortController is null", () => {
    // Simulate the logic: if (abortController) { ... }
    let abortController = null;
    let messages = [];

    function handleAbort() {
      if (abortController) {
        messages.push("[Aborted -- Escape]");
      }
      // No abortController = nothing running — silently ignore
    }

    handleAbort();
    handleAbort();
    handleAbort();
    expect(messages).toHaveLength(0);
  });

  it("handleAbort shows message when abortController exists", () => {
    let abortController = { abort: () => {} };
    let messages = [];

    function handleAbort() {
      if (abortController) {
        abortController.abort();
        messages.push("[Aborted -- Escape]");
        abortController = null; // cleared after abort
      }
    }

    handleAbort();
    expect(messages).toHaveLength(1);

    // Second press — nothing running anymore
    handleAbort();
    expect(messages).toHaveLength(1);
  });
});

// ============================================================
// Supervisor rules
// ============================================================
describe("Supervisor rules", () => {
  // Import-like simulation of evaluateToolCall logic
  function checkClickWithoutLook(toolHistory) {
    const last = toolHistory[toolHistory.length - 1];
    if (!last?.name.includes("click")) return null;
    const prior = toolHistory.slice(0, -1).reverse();
    const lastLook = prior.find(t => t.name.includes("look"));
    const lastScreenshot = prior.find(t => t.name.includes("screenshot"));
    if (!lastLook || (lastScreenshot && lastScreenshot.ts > lastLook.ts)) {
      return "HINT: Always use desktop_look BEFORE clicking";
    }
    return null;
  }

  it("detects click without prior look", () => {
    const history = [
      { name: "desktop_screenshot", ts: 1 },
      { name: "desktop_click", ts: 2 },
    ];
    expect(checkClickWithoutLook(history)).toContain("desktop_look");
  });

  it("allows click after look", () => {
    const history = [
      { name: "desktop_screenshot", ts: 1 },
      { name: "desktop_look", ts: 2 },
      { name: "desktop_click", ts: 3 },
    ];
    expect(checkClickWithoutLook(history)).toBeNull();
  });

  it("detects click after screenshot but no look", () => {
    const history = [
      { name: "desktop_look", ts: 1 },
      { name: "desktop_screenshot", ts: 2 }, // screenshot after look = look is stale
      { name: "desktop_click", ts: 3 },
    ];
    expect(checkClickWithoutLook(history)).toContain("desktop_look");
  });
});

// ============================================================
// Intent-based tool loading
// ============================================================
describe("Intent detection", () => {
  // Simulate detectIntent logic
  const PATTERNS = [
    { pattern: /screenshot|screen|click|desktop|browse|chrome/i, category: "desktop" },
    { pattern: /email|mail|inbox|gmail/i, category: "email" },
    { pattern: /background|process|kill|pid|daemon/i, category: "process" },
    { pattern: /http|url|fetch|download|web\s*search/i, category: "web" },
    { pattern: /remember|memory|forget|recall/i, category: "memory" },
    { pattern: /task|plan|objective|milestone|todo/i, category: "planning" },
  ];

  function detectIntent(msg) {
    const intents = new Set(["core"]);
    for (const { pattern, category } of PATTERNS) {
      if (pattern.test(msg)) intents.add(category);
    }
    if (intents.size === 1) intents.add("filesystem");
    return intents;
  }

  it("detects desktop intent from 'take a screenshot'", () => {
    const intents = detectIntent("Take a screenshot of desktop-1");
    expect(intents.has("desktop")).toBe(true);
    expect(intents.has("core")).toBe(true);
  });

  it("detects email intent", () => {
    const intents = detectIntent("Send an email to john@example.com");
    expect(intents.has("email")).toBe(true);
  });

  it("defaults to filesystem for generic requests", () => {
    const intents = detectIntent("List files in the current directory");
    expect(intents.has("filesystem")).toBe(true);
    expect(intents.has("desktop")).toBe(false);
  });

  it("detects intent from natural language", () => {
    const intents = detectIntent("open chrome browser");
    expect(intents.has("desktop")).toBe(true);
  });

  it("detects multiple intents", () => {
    const intents = detectIntent("Take a screenshot and send it by email");
    expect(intents.has("desktop")).toBe(true);
    expect(intents.has("email")).toBe(true);
  });
});
