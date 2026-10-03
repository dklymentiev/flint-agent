// Desktop hints must not fire on ordinary text.
//
// "the desktop supervisor fires on ordinary text — 'discard', 'recovery' and
//  'Tip of the Day' appear in file contents, test output and documentation,
//  and the agent is told to look for a dialog that isn't there."
//
// It is a real hazard beyond being noisy. A hint that says "press alt+d to
// DISCARD" is an instruction to press a key that discards work, and the
// condition that produces it is the word "discard" appearing anywhere in any
// tool result. An agent that reads tests/e2e/parallel-and-recovery.test.js is
// told to go and discard something.
//
// Three rules are affected, and all three have the same defect: they match on
// the *result string alone*, with no check that a desktop tool ran or that a
// dialog was observed. Every other rule in the file keys on the tool name or
// its arguments, which is what makes it a hint about a specific action rather
// than a guess about a word.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  evaluateToolCall, resetSupervisor, setSupervisorEnabled, isSupervisorEnabled,
} from "../../../src/agent/supervisor.js";

// evaluateToolCall returns the hint text itself, or null — it assembles
// `hints.join("\n")` and prefixes it with a repetition level before returning.
// It also returns null outright when the supervisor is off, so a hint that is
// "absent" and a hint that is "not enabled" are the same null, which is why
// every test below enables it explicitly.
const hintsFor = (toolName, result, args = {}) =>
  evaluateToolCall(toolName, args, result) ?? "";

// The supervisor is off until /supervisor turns it on (or an API message
// auto-enables it), and evaluateToolCall returns null while it is off. Every
// test here is about what it says *when it is on*, so it has to be on.
let wasEnabled = false;
beforeEach(() => {
  wasEnabled = isSupervisorEnabled();
  setSupervisorEnabled(true);
  resetSupervisor();
});
afterEach(() => {
  setSupervisorEnabled(wasEnabled);
  resetSupervisor();
});

describe("an ordinary file read must not raise a desktop hint", () => {
  it("does not claim a recovery dialog after reading a test file", () => {
    // The exact case that produced the supervisor hint this whole session: a
    // file whose name contains "recovery" was read, and the words in it.
    const out = hintsFor("read_file", "parallel-and-recovery.test.js\n  it('recovers after a crash')");
    expect(out).not.toMatch(/Recovery dialog/i);
    expect(out).not.toMatch(/alt\+d/i);
  });

  it("does not tell the agent to discard after a test run mentions discarding", () => {
    const out = hintsFor("run_command", "3 passed\n  discards the temp dir on exit\n  recovery: skipped");
    expect(out).not.toMatch(/DISCARD/i);
    expect(out).not.toMatch(/alt\+d/i);
  });

  it("does not fire on git output that says recovery", () => {
    const out = hintsFor("run_command", "On branch main\nnothing to commit, working tree clean");
    expect(out).not.toMatch(/Recovery/i);
  });

  it("does not fire on the words appearing in documentation", () => {
    const out = hintsFor("web_fetch", "To recover a discarded commit, run git reflog. Tip of the Day: use tabs.");
    expect(out).not.toMatch(/Tip of the Day/i);
    expect(out).not.toMatch(/Text Import/i);
  });

  it("does not fire on a bare word with no context at all", () => {
    // The most degenerate case, and the one the old rules could not tell apart
    // from a real dialog screenshot.
    for (const word of ["discard", "recover", "Discard", "Recovery", "recovery", "Tip of the Day", "Text Import"]) {
      // Reset between words: the loop itself is seven identical read_file calls,
      // which trips the "same tool 3 times with the SAME arguments" rule and
      // would report a loop hint for a call that only ever happened inside this
      // test. Each word has to be seen on its own.
      resetSupervisor();
      expect(hintsFor("read_file", word), word).toBe("");
    }
  });
});

describe("the desktop rules still fire on a real desktop tool", () => {
  it("reports a recovery dialog after desktop_look actually sees one", () => {
    // The rule is not wrong, it is unguarded. desktop_look is the tool that
    // observes the screen, so its result is evidence.
    const out = hintsFor("desktop_look", "Document Recovery: 3 documents. Buttons: Discard, Cancel.");
    expect(out).toMatch(/Recovery dialog/i);
  });

  it("reports a tip of the day after a screenshot of one", () => {
    const out = hintsFor("desktop_screenshot", "Tip of the Day: you can pin tabs in Firefox");
    expect(out).toMatch(/Tip of the Day/i);
  });

  it("reports a text import dialog after a screenshot of one", () => {
    const out = hintsFor("desktop_screenshot", "Text Import dialog: choose a delimiter");
    expect(out).toMatch(/Text Import/i);
  });
});

describe("the rules that were already correct are untouched", () => {
  it("still warns about a GUI app started without DISPLAY", () => {
    // This one already keyed on the shell command, which is why it does not
    // misfire on prose. Guards against a fix that narrows too far.
    const out = hintsFor("shell", "", { command: "soffice --calc" });
    expect(out).toMatch(/DISPLAY/);
  });

  it("still knows the Save As workflow when ctrl+shift+s is pressed", () => {
    const out = hintsFor("desktop_key", "", { keys: "ctrl+shift+s" });
    expect(out).toMatch(/Save As/i);
  });
});

describe("a non-desktop tool that mentions a dialog is still not a dialog", () => {
  it("a screenshot tool is not evidence if the tool is something else entirely", () => {
    // Guards the shape of the fix: it must key on the tool being a desktop
    // observation, not on the result merely looking screen-like.
    const out = hintsFor("web_fetch", "Recovery dialog detected on example.com. Tip of the Day.");
    expect(out).toBe("");
  });

  it("an MCP tool that happens to see the screen still needs to look like a desktop tool", () => {
    // mcp_screenbox_screenshot is an observer too, and is a legitimate source
    // of this evidence. It is named without the desktop_ prefix, so the guard
    // has to be about capability rather than spelling.
    const out = hintsFor("mcp_screenbox_screenshot", "Document Recovery: 2 documents. Discard button.");
    expect(out).toMatch(/Recovery dialog/i);
  });
});
