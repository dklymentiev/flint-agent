// Flint's ledger look (owner, 2026-10-01): one line per tool call, a receipt
// per turn, and an activity row with running dots and a verb.
import { describe, it, expect } from "vitest";
import stringWidth from "string-width";
import { toolCategory, toolArgument, toolOutcome, ledgerLine, receiptLine, formatDuration } from "../../../src/ui/tool-ledger.js";
import { activityText, activityVerb, spinnerFrame, SPINNER_FRAME_MS, ACTIVITY_BLOCK_WIDTH, liveToolText } from "../../../src/components/LiveZone.js";

const plain = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, "");

describe("toolCategory", () => {
  it("names the category and the verb", () => {
    expect(toolCategory("read_file")).toEqual(["fs", "read"]);
    expect(toolCategory("run_command")).toEqual(["sh", "run"]);
    expect(toolCategory("web_search")).toEqual(["web", "search"]);
    expect(toolCategory("memory_write")).toEqual(["mem", "write"]);
  });
  it("names an MCP tool by its server", () => {
    expect(toolCategory("mcp_planner_create_task")).toEqual(["mcp", "planner"]);
  });
  it("falls back for a tool it does not know", () => {
    expect(toolCategory("check_balance")).toEqual(["sys", "check balance"]);
  });
});

describe("toolOutcome", () => {
  it("reads the exit code of a failed command", () => {
    expect(toolOutcome("run_command", "Error (exit 2): nope")).toEqual({ text: "exit 2", bad: true });
  });
  it("reports a successful command as exit 0", () => {
    expect(toolOutcome("run_command", "hello")).toEqual({ text: "exit 0", bad: false });
  });
  it("reports size for other results", () => {
    expect(toolOutcome("read_file", "x".repeat(2048)).text).toBe("2.0 KB");
  });
  it("says denied", () => {
    expect(toolOutcome("write_file", "", true)).toEqual({ text: "denied", bad: true });
  });
});

describe("ledgerLine", () => {
  it("is one dim, indented line with left-aligned columns", () => {
    const raw = ledgerLine({ name: "run_command", args: { command: "ping -n 5 127.0.0.1" }, result: "ok", ms: 4100, columns: 120 });
    const line = plain(raw);
    expect(line).not.toContain("\n");
    // Dim as a whole: the ledger is secondary and carries no per-column colour.
    // (With colour support off in the test runner there are no codes at all.)
    expect(raw.replace(/\x1b\[(2|22)m/g, "")).toBe(line);
    expect(line).toMatch(/^ {6}sh {4}run {5}ping -n 5 127\.0\.0\.1 +exit 0 {3}4\.1s$/);
  });
  it("keeps result and time in the same columns on every line", () => {
    const a = plain(ledgerLine({ name: "read_file", args: { path: "a.js" }, result: "x", ms: 3, columns: 120 }));
    const b = plain(ledgerLine({ name: "web_search", args: { query: "a much longer query than the first one" }, result: "x", ms: 300, columns: 120 }));
    expect(a.indexOf("1 B")).toBe(b.indexOf("1 B"));
  });
  it("stays within 60% of a wide window", () => {
    const line = plain(ledgerLine({ name: "read_file", args: { path: "a/".repeat(200) }, result: "x", ms: 3, columns: 200 }));
    expect(stringWidth(line)).toBeLessThanOrEqual(120);
  });
  it("cuts a long path in the middle, keeping the file name", () => {
    const line = plain(ledgerLine({ name: "read_file", args: { path: "C:/Users/someone/AppData/Local/Temp/flint-demo/some/deep/folder/fib.js" }, result: "x", ms: 3, columns: 100 }));
    expect(line).toContain("…");
    expect(line).toContain("fib.js");
    expect(line).toContain("C:/");
  });
});

describe("receiptLine", () => {
  it("closes a turn with tools, changed files, time and cost", () => {
    const line = plain(receiptLine({ turn: 7, tools: 4, files: ["C:/x/fib.js"], ms: 6200, cost: 0, sessionCost: 0.0076, columns: 160 }));
    expect(line).toContain("turn 7 · 4 tools · changed fib.js · 6.2s · $0.0000 (session $0.0076)");
    expect(stringWidth(line)).toBeLessThanOrEqual(96); // 60% of 160
  });
  it("states the turn's tokens in and out", () => {
    const line = plain(receiptLine({ turn: 5, tools: 1, files: [], ms: 2500, cost: 0, tokensIn: 8234, tokensOut: 142, columns: 160 }));
    expect(line).toContain("8.2k in / 142 out tok");
  });
  it("names how a turn ended when it did not end normally", () => {
    expect(plain(receiptLine({ turn: 2, tools: 0, files: [], ms: 10, cost: 0, stopped: "budget" }))).toContain("budget");
  });
  it("claims no files when the disk could not be read", () => {
    expect(plain(receiptLine({ turn: 1, tools: 2, files: null, ms: 10, cost: 0 }))).not.toContain("changed");
  });
});

describe("footer activity block", () => {
  it("runs a gap clockwise round a 2x2 square of dots, in one character", () => {
    const frames = [0, 1, 2, 3, 4].map((i) => spinnerFrame(i * SPINNER_FRAME_MS));
    expect(frames).toEqual(["⠚", "⠓", "⠋", "⠙", "⠚"]);
  });
  it("has the same width idle and in every busy state, so the footer never shifts", () => {
    const now = 100_000;
    const states = [
      { agentStatus: "idle" },
      { agentStatus: "thinking", activity: { kind: "call" }, activityStartedAt: now - 3000 },
      { agentStatus: "streaming", activity: { kind: "answering" }, activityStartedAt: now - 7000, activityTokens: 1234 },
      { agentStatus: "calling-tool", activity: { kind: "tool", tool: "run_command", arg: "a very long command indeed" }, activityStartedAt: now - 83000 },
    ];
    for (const st of states) expect(stringWidth(activityText(st, now))).toBe(ACTIVITY_BLOCK_WIDTH);
  });
  it("says writing with the clock and tokens while the model answers", () => {
    const now = 100_000;
    const text = activityText({ agentStatus: "streaming", activity: { kind: "answering" }, activityStartedAt: now - 7000, activityTokens: 312 }, now);
    expect(text).toMatch(/^[⠚⠓⠋⠙] writing\s+00:07\s+↓ 312 tok/);
  });
  it("says only running for a tool; the command goes in the window above", () => {
    const st = { agentStatus: "calling-tool", activity: { kind: "tool", tool: "run_command", arg: "ping -n 15" } };
    expect(activityVerb(st)).toBe("running");
    expect(activityText(st)).not.toContain("ping");
    expect(liveToolText(st, 120)).toContain("sh    run     ping -n 15");
  });
  it("says waiting when idle", () => {
    // Idle reads as idle: a dot and "ready". A dot block and "waiting" read
    // as a stuck spinner to the owner twice (2026-10-02).
    expect(activityText({ agentStatus: "idle" }).trim()).toBe("· ready");
  });
});

describe("formatDuration", () => {
  it("reads naturally at every scale", () => {
    expect(formatDuration(12)).toBe("12ms");
    expect(formatDuration(4100)).toBe("4.1s");
    expect(formatDuration(83000)).toBe("1m23s");
  });
});

describe("background processes in the ledger", () => {
  it("names a started process by its id, not the size of the reply", () => {
    const line = plain(ledgerLine({ name: "run_background_command", args: { command: "ping -n 180 127.0.0.1" }, result: "Background process started (id: 6, pid: 22172). Command: ping", ms: 20, columns: 130 }));
    expect(line).toMatch(/sh\s+start\s+ping -n 180 127\.0\.0\.1\s+bg 6\s+20ms$/);
  });
  it("prints a process's end in the same columns", async () => {
    const { processLedgerLine } = await import("../../../src/ui/tool-ledger.js");
    const start = plain(ledgerLine({ name: "run_background_command", args: { command: "ping -n 180 127.0.0.1" }, result: "Background process started (id: 6, pid: 1)", ms: 20, columns: 130 }));
    const end = plain(processLedgerLine({ verb: "killed", cmd: "ping -n 180 127.0.0.1", procId: 6, elapsed: "3m 2s", columns: 130 }));
    expect(end).toMatch(/sh\s+killed\s+ping -n 180 127\.0\.0\.1\s+bg 6\s+3m 2s$/);
    expect(end.indexOf("bg 6")).toBe(start.indexOf("bg 6"));
  });
  it("drops the repeat counter from the dock", async () => {
    const { dockRows } = await import("../../../src/components/LiveZone.js");
    const [row] = dockRows([{ id: 7, cmd: "ping", status: "running", output: ["Reply from 127.0.0.1 (x2)"] }]);
    expect(row).toContain("Reply from 127.0.0.1");
    expect(row).not.toContain("(x2)");
  });
});

describe("context in the status line", () => {
  it("shows size over limit, not a percentage", async () => {
    const { statusText, compactCount } = await import("../../../src/components/LiveZone.js");
    expect([950, 22456, 1048576, 1500000].map(compactCount)).toEqual(["950", "22k", "1M", "1.5M"]);
    expect(statusText({ contextTokens: 22456, contextLimit: 1048576, processes: [] })).toContain("ctx 22k/1M");
  });
});

describe("toolOutcome for writes and edits", () => {
  // "fs write ... 51 B" was the length of the reply "File written: <path>"
  // for a 7.8 KB document (owner, 2026-10-02).
  it("a write is measured by what it wrote", () => {
    const content = "x".repeat(8000);
    expect(toolOutcome("write_file", "File written: C:\tmp\a.md", false, { path: "a.md", content })).toEqual({ text: "7.8 KB", bad: false });
  });

  it("an edit says how many lines it replaced with how many", () => {
    expect(toolOutcome("edit_file", "Replaced 1 occurrence(s)", false, { old_text: "a\nb\nc\nd", new_text: "a\nb\nc\nd\ne\nf" }))
      .toEqual({ text: "-4 +6", bad: false });
  });

  it("a failed write is still an error", () => {
    expect(toolOutcome("write_file", "Error: EACCES", false, { content: "x" })).toEqual({ text: "error", bad: true });
  });
});
