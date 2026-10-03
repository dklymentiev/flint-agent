import { describe, it, expect, vi } from "vitest";

vi.mock("../../../src/commands/commands.js", () => ({ registerCommands: () => ({}) }));
const { isSlashCommand } = await import("../../../src/commands/registry.js");

// In a benchmark run, a task starting with an absolute path was taken
// for an unknown command and never reached the agent.
describe("isSlashCommand", () => {
  it("takes command names, with or without arguments", () => {
    for (const s of ["/help", "/mcp", "/queue clear", "/model xiaomi/mimo-v2.5-pro", "/allow-all", "  /stats  ", "/nosuchcmd"]) {
      expect(isSlashCommand(s), s).toBe(true);
    }
  });

  it("leaves a message that starts with an absolute path to the agent", () => {
    for (const s of [
      "/work/match.mp4 is 12 seconds long. Cut out just the middle.",
      "/tmp/report.pdf needs a summary",
      "/etc/hosts: what does it resolve localhost to?",
      "/notes.txt has my list",
    ]) {
      expect(isSlashCommand(s), s).toBe(false);
    }
  });

  it("leaves ordinary text alone", () => {
    for (const s of ["hello", "a/b", "", "/", "/ help"]) {
      expect(isSlashCommand(s), s).toBe(false);
    }
  });
});
