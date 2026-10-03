// The tools a turn gets, and the operator's right to be told.
//
// 2026-09-29, one evening, three turns where the classifier's guess took the
// tools away from work that was in progress and nobody was told:
//
//   "Read <brief> and do what it says"   -> file_read  (1 tool, 3 steps)
//   "so why did you stop"                -> chat       (0 tools)
//   "Continue the task: write the fix
//    and the tests as files ...,
//    run them with npx vitest, commit."  -> chat       (0 tools)
//
// The third one then had the model write its tool calls out as text, 9 KB of
// it, and nothing ran them.

import { describe, it, expect } from "vitest";
import {
  decideToolScope, describeToolScope, isMidTask, pointsAtInstructions, untrustedToolSet,
} from "../../../src/agent/tool-guard.js";

const defs = (names) => names.map((name) => ({ type: "function", function: { name, description: name } }));

const BUILTINS = defs([
  "read_file", "write_file", "edit_file", "list_directory", "search_in_files", "glob",
  "run_command", "run_background_command", "peek_process", "web_search", "web_fetch", "think",
  "tool_search",
]);
const WITH_MCP = [...BUILTINS, ...defs(["mcp_browser_navigate", "mcp_screenbox_screenshot"])];

describe("isMidTask", () => {
  it("is true once a tool has run in this session", () => {
    expect(isMidTask({ priorToolCalls: true, priorTurns: 1 })).toBe(true);
  });

  it("is true on a later turn even with no tool yet", () => {
    expect(isMidTask({ priorToolCalls: false, priorTurns: 1 })).toBe(true);
  });

  it("is false on the first message of a session", () => {
    expect(isMidTask({ priorToolCalls: false, priorTurns: 0 })).toBe(false);
  });
});

describe("pointsAtInstructions", () => {
  it("notices a message that hands the work to a file", () => {
    expect(pointsAtInstructions("Read C:/tmp/brief.md and do what it says")).toBeTruthy();
  });

  it("notices a phrase with no file in it", () => {
    expect(pointsAtInstructions("do what the brief says")).toBeTruthy();
  });

  it("leaves an ordinary request alone", () => {
    expect(pointsAtInstructions("what is the capital of France?")).toBeNull();
  });

  it("does not fire on a non-instruction extension", () => {
    expect(pointsAtInstructions("read src/index.js")).toBeNull();
  });
});

describe("untrustedToolSet", () => {
  it("rejects a text-only class in the middle of a task", () => {
    const out = untrustedToolSet({
      manifest: { intent: "chat", tools: [] },
      message: "so why did you stop",
      ctx: { priorToolCalls: true },
    });
    expect(out).toBeTruthy();
    expect(out.reason).toContain("mid-task");
  });

  it("rejects a message pointing at instructions, even on the first turn", () => {
    const out = untrustedToolSet({
      manifest: { intent: "file_read", tools: ["read_file"] },
      message: "Read C:/tmp/brief.md and do what it says",
      ctx: {},
    });
    expect(out).toBeTruthy();
    expect(out.reason).toContain("instructions");
  });

  it("rejects one tool for a mid-task message", () => {
    const out = untrustedToolSet({
      manifest: { intent: "file_read", tools: ["read_file"] },
      message: "keep going",
      ctx: { priorToolCalls: true },
    });
    expect(out).toBeTruthy();
    expect(out.reason).toContain("1 tool");
  });

  it("trusts a tool set big enough to do the work", () => {
    const out = untrustedToolSet({
      manifest: { intent: "complex_multi", tools: BUILTINS.map((t) => t.function.name) },
      message: "keep going",
      ctx: { priorToolCalls: true },
    });
    expect(out).toBeNull();
  });

  it("trusts a narrow set on a first message that names its whole job", () => {
    const out = untrustedToolSet({
      manifest: { intent: "web_search", tools: ["web_search", "web_fetch"] },
      message: "search the web for the flint agent repo",
      ctx: {},
    });
    expect(out).toBeNull();
  });
});

describe("decideToolScope", () => {
  it("widens to the built-in surface for a mid-task message", () => {
    const scope = decideToolScope({
      manifest: { intent: "chat", tools: [] },
      allDefs: BUILTINS,
      narrowedTools: [],
      message: "Continue the task: write the fix and the tests, run them, commit.",
      ctx: { priorToolCalls: true },
    });
    expect(scope.widened).toBe(true);
    expect(scope.tools.map((t) => t.function.name)).toContain("edit_file");
    expect(scope.tools.map((t) => t.function.name)).toContain("run_command");
    expect(scope.tools.map((t) => t.function.name)).toContain("write_file");
  });

  it("leaves MCP tools out of the widening — they cost 33k tokens a call", () => {
    const scope = decideToolScope({
      manifest: { intent: "chat", tools: [] },
      allDefs: WITH_MCP,
      narrowedTools: [],
      message: "keep going",
      ctx: { priorToolCalls: true },
    });
    const names = scope.tools.map((t) => t.function.name);
    expect(names.some((n) => n.startsWith("mcp_"))).toBe(false);
    expect(names).toContain("tool_search");
  });

  it("does not overrule the dangerous assessment gate", () => {
    const scope = decideToolScope({
      manifest: { intent: "chat", tools: [] },
      allDefs: BUILTINS,
      narrowedTools: [],
      blockTools: true,
      message: "keep going",
      ctx: { priorToolCalls: true },
    });
    expect(scope.tools).toEqual([]);
    expect(scope.widened).toBe(false);
  });

  it("leaves a trusted narrowing exactly as the classifier chose it", () => {
    const narrowed = defs(["web_search", "web_fetch"]);
    const scope = decideToolScope({
      manifest: { intent: "web_search", tools: ["web_search", "web_fetch"] },
      allDefs: BUILTINS,
      narrowedTools: narrowed,
      message: "search the web for flint",
      ctx: {},
    });
    expect(scope.tools).toBe(narrowed);
    expect(scope.widened).toBe(false);
  });

  it("tells the operator which class it was and how many tools survived", () => {
    const scope = decideToolScope({
      manifest: { intent: "chat", tools: [] },
      allDefs: BUILTINS,
      narrowedTools: [],
      message: "go on, run what you need",
      ctx: { priorToolCalls: true },
    });
    expect(scope.note).toContain("chat");
    expect(scope.note).toMatch(/\d+ of \d+ tools/);
    expect(scope.note).toContain("widened");
  });
});

describe("describeToolScope", () => {
  it("says nothing when nothing was narrowed", () => {
    expect(describeToolScope({ manifest: { intent: "chat" }, allDefs: BUILTINS, tools: BUILTINS })).toBe("");
  });

  it("names the mode and the count when tools were taken away", () => {
    const note = describeToolScope({ manifest: { intent: "file_read" }, allDefs: BUILTINS, tools: defs(["read_file"]) });
    expect(note).toContain("mode file_read");
    expect(note).toContain(`1 of ${BUILTINS.length} tools`);
  });
});