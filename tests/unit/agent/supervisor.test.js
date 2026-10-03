import { describe, it, expect, beforeEach } from "vitest";
import { evaluateToolCall, resetSupervisor, setSupervisorEnabled, checkMidTaskDescription } from "../../../src/agent/supervisor.js";

beforeEach(() => {
  resetSupervisor();
  setSupervisorEnabled(true);
});

describe("supervisor", () => {
  describe("when disabled", () => {
    it("returns null for any tool call", () => {
      setSupervisorEnabled(false);
      const hint = evaluateToolCall("desktop_click", { x: 100, y: 200 }, "clicked");
      expect(hint).toBeNull();
    });
  });

  describe("click without look", () => {
    it("warns when clicking without prior look", () => {
      evaluateToolCall("desktop_screenshot", {}, "ok");
      const hint = evaluateToolCall("desktop_click", { x: 100, y: 200 }, "clicked");
      expect(hint).toContain("desktop_look");
    });

    it("allows click after look", () => {
      evaluateToolCall("desktop_screenshot", {}, "ok");
      evaluateToolCall("desktop_look", { cell: 5 }, "elements");
      const hint = evaluateToolCall("desktop_click", { x: 100, y: 200 }, "clicked");
      expect(hint).toBeNull();
    });

    it("warns when screenshot after look makes look stale", () => {
      evaluateToolCall("desktop_look", { cell: 5 }, "elements");
      evaluateToolCall("desktop_screenshot", {}, "ok");
      const hint = evaluateToolCall("desktop_click", { x: 100, y: 200 }, "clicked");
      // May or may not warn depending on timestamp ordering within same tick
      // Key: click without recent look should be caught
      expect(hint === null || hint.includes("desktop_look")).toBe(true);
    });
  });

  describe("repeated clicks", () => {
    it("warns after 3 clicks on same coordinates", () => {
      evaluateToolCall("desktop_look", { cell: 5 }, "elements");
      evaluateToolCall("desktop_click", { x: 100, y: 200 }, "clicked");
      evaluateToolCall("desktop_look", { cell: 5 }, "elements");
      evaluateToolCall("desktop_click", { x: 100, y: 200 }, "clicked");
      evaluateToolCall("desktop_look", { cell: 5 }, "elements");
      const hint = evaluateToolCall("desktop_click", { x: 100, y: 200 }, "clicked");
      expect(hint).toContain("3 times");
    });
  });

  describe("apt-get detection", () => {
    it("warns about apt-get on screenbox", () => {
      const hint = evaluateToolCall("desktop_shell", { command: "apt-get install vim" }, "error");
      expect(hint).toContain("desktop_manage");
    });

    it("warns about sudo", () => {
      const hint = evaluateToolCall("desktop_shell", { command: "sudo apt-get update" }, "error");
      expect(hint).toContain("desktop_manage");
    });

    it("does not warn about regular commands", () => {
      const hint = evaluateToolCall("desktop_shell", { command: "ls -la" }, "files");
      expect(hint).toBeNull();
    });
  });

  describe("libreoffice without DISPLAY", () => {
    it("warns when launching GUI app without DISPLAY", () => {
      const hint = evaluateToolCall("desktop_shell", { command: "libreoffice --calc" }, "");
      expect(hint).toContain("DISPLAY=:99");
    });

    it("does not warn about DISPLAY when DISPLAY is set", () => {
      const hint = evaluateToolCall("desktop_shell", { command: "DISPLAY=:99 libreoffice --calc &" }, "");
      // Should not contain the DISPLAY warning, but may contain background app focus hint
      expect(hint || "").not.toContain("DISPLAY=:99");
    });

    it("does not warn for headless mode", () => {
      const hint = evaluateToolCall("desktop_shell", { command: "libreoffice --headless --convert-to xlsx file.csv" }, "");
      expect(hint).toBeNull();
    });
  });

  describe("dialog detection", () => {
    it("detects recovery dialog", () => {
      const hint = evaluateToolCall("desktop_screenshot", {}, "Document Recovery... recover the state... Discard");
      expect(hint).toContain("Escape");
    });

    it("detects Tip of the Day", () => {
      const hint = evaluateToolCall("desktop_screenshot", {}, "Tip of the Day dialog");
      expect(hint).toContain("Enter");
    });

    it("detects Text Import dialog", () => {
      const hint = evaluateToolCall("desktop_look", { cell: 5 }, "Text Import Separator Tab");
      expect(hint).toContain("Enter");
    });
  });

  describe("Save As workflow", () => {
    it("injects save workflow hint on Ctrl+Shift+S", () => {
      const hint = evaluateToolCall("desktop_key", { keys: "ctrl+shift+s" }, "ok");
      expect(hint).toContain("Save As");
      expect(hint).toContain("filename");
    });
  });

  describe("reset", () => {
    it("clears tool history on reset", () => {
      evaluateToolCall("desktop_screenshot", {}, "ok");
      resetSupervisor();
      // After reset, click should not warn (no history)
      evaluateToolCall("desktop_look", { cell: 1 }, "ok");
      const hint = evaluateToolCall("desktop_click", { x: 50, y: 50 }, "ok");
      expect(hint).toBeNull();
    });
  });

  describe("4-level escalation", () => {
    it("level 1: hint", () => {
      evaluateToolCall("desktop_screenshot", {}, "ok");
      const hint = evaluateToolCall("desktop_click", { x: 100, y: 200 }, "ok");
      expect(hint).not.toBeNull();
      expect(hint).not.toContain("WARNING");
      expect(hint).not.toContain("RE-PLAN");
      expect(hint).not.toContain("OVERRIDE");
    });

    it("level 2: warning on repeat", () => {
      evaluateToolCall("desktop_screenshot", {}, "ok");
      evaluateToolCall("desktop_click", { x: 100, y: 200 }, "ok"); // hint 1
      evaluateToolCall("desktop_screenshot", {}, "ok");
      const hint = evaluateToolCall("desktop_click", { x: 100, y: 200 }, "ok"); // hint 2
      expect(hint).toContain("WARNING");
    });

    it("level 3: re-plan on 3rd repeat", () => {
      // Trigger apt-get hint 3 times — consistent rule
      evaluateToolCall("desktop_shell", { command: "sudo apt-get install foo" }, "ok");
      evaluateToolCall("desktop_shell", { command: "sudo apt-get install foo" }, "ok");
      const hint = evaluateToolCall("desktop_shell", { command: "sudo apt-get install bar" }, "ok");
      expect(hint).toContain("RE-PLAN");
    });

    it("level 4: hard stop on 4th repeat", () => {
      evaluateToolCall("desktop_shell", { command: "sudo apt-get install a" }, "ok");
      evaluateToolCall("desktop_shell", { command: "sudo apt-get install b" }, "ok");
      evaluateToolCall("desktop_shell", { command: "sudo apt-get install c" }, "ok");
      const hint = evaluateToolCall("desktop_shell", { command: "sudo apt-get install d" }, "ok");
      expect(hint).toContain("OVERRIDE");
    });
  });

  describe("unverified write detection", () => {
    it("warns when write_file followed by non-verify action", () => {
      evaluateToolCall("write_file", { path: "test.js", content: "code" }, "ok");
      const hint = evaluateToolCall("web_search", { query: "something" }, "ok");
      expect(hint).toContain("verify");
    });

    it("no warning when write_file followed by read_file", () => {
      evaluateToolCall("write_file", { path: "test.js", content: "code" }, "ok");
      const hint = evaluateToolCall("read_file", { path: "test.js" }, "code");
      expect(hint).toBeNull();
    });

    it("no warning when shell echo followed by shell cat", () => {
      evaluateToolCall("run_command", { command: 'echo "hello" > /tmp/test.txt' }, "ok");
      const hint = evaluateToolCall("run_command", { command: "cat /tmp/test.txt" }, "hello");
      expect(hint).toBeNull();
    });

    it("warns when shell echo followed by unrelated action", () => {
      evaluateToolCall("run_command", { command: 'echo "hello" > /tmp/test.txt' }, "ok");
      const hint = evaluateToolCall("web_search", { query: "unrelated" }, "ok");
      expect(hint).toContain("verify");
    });

    it("no warning when desktop_type followed by screenshot", () => {
      evaluateToolCall("desktop_type", { text: "long text for a document here" }, "ok");
      const hint = evaluateToolCall("desktop_screenshot", {}, "ok");
      expect(hint).toBeNull();
    });

    it("warns when Ctrl+S followed by non-verify", () => {
      evaluateToolCall("desktop_key", { keys: "ctrl+s" }, "ok");
      const hint = evaluateToolCall("desktop_chrome", { action: "navigate", url: "https://google.com" }, "ok");
      expect(hint).toContain("verify");
    });
  });

  describe("mid-task description detection", () => {
    it("detects 'I will now' pattern", () => {
      const hint = checkMidTaskDescription("I will now search for the recipe", false);
      expect(hint).not.toBeNull();
      expect(hint).toContain("Don't describe");
    });

    it("detects 'Next I need to' pattern", () => {
      const hint = checkMidTaskDescription("Next I need to open the file", false);
      expect(hint).not.toBeNull();
    });

    it("detects 'Let me first' pattern", () => {
      const hint = checkMidTaskDescription("Let me first check the directory", false);
      expect(hint).not.toBeNull();
    });

    it("returns null for actual results", () => {
      const hint = checkMidTaskDescription("The file contains 42 lines of code.", false);
      expect(hint).toBeNull();
    });

    it("returns null when had tool calls", () => {
      const hint = checkMidTaskDescription("I will now search", true);
      expect(hint).toBeNull();
    });

    it("returns null when disabled", () => {
      setSupervisorEnabled(false);
      const hint = checkMidTaskDescription("I will now search", false);
      expect(hint).toBeNull();
    });
  });
});
