// A long foreground command shows its latest output line (owner, 2026-10-01).
import { describe, it, expect } from "vitest";
import { lastOutputLine } from "../../../src/ui/last-line.js";
import { liveToolText } from "../../../src/components/LiveZone.js";

describe("lastOutputLine", () => {
  it("takes the last non-empty line", () => {
    expect(lastOutputLine("scanning 192.0.2.1\nscanning 192.0.2.2\n\n")).toBe("scanning 192.0.2.2");
  });
  it("shows a progress bar's latest redraw, not all of them", () => {
    expect(lastOutputLine("[#---] 25%\r[##--] 50%\r[###-] 75%")).toBe("[###-] 75%");
  });
  it("drops colour codes", () => {
    expect(lastOutputLine("\x1b[32mPASS\x1b[0m src/a.test.js")).toBe("PASS src/a.test.js");
  });
  it("is null for output with nothing visible", () => {
    expect(lastOutputLine("\n\r\n  \n")).toBe(null);
  });
});

describe("activity row with command output", () => {
  const base = { agentStatus: "calling-tool", activity: { label: "running run_command: nmap -sV" }, activityStartedAt: Date.now() };
  // Since 2026-10-01 the command and its output line are on the tool row
  // above the input; the footer only says "running".
  const tool = { ...base, activity: { kind: "tool", tool: "run_command", arg: "nmap -sV" } };
  it("adds the latest output line to the tool row", () => {
    expect(liveToolText({ ...tool, activityDetail: "Discovered open port 22/tcp" }, 120)).toContain("| Discovered open port 22/tcp");
  });
  it("shows only the command when there is no output yet", () => {
    expect(liveToolText(tool, 120)).not.toContain("|");
  });
});
