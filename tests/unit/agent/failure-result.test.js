// isFailureResult drives the RECOVER gate. From 2aee213 (2026-09-21) its
// word boundaries were literal backspace bytes, so "Error: ENOENT" and every
// other \b-guarded marker never matched and RECOVER stayed silent on tool
// errors. Nothing tested it.

import { describe, it, expect } from "vitest";
import { isFailureResult } from "../../../src/agent/learning.js";

describe("isFailureResult", () => {
  it.each([
    "Error: ENOENT: no such file or directory, stat 'x.txt'",
    "error executing tool",
    "bash: foo: command not found",
    "open x: permission denied",
    "Failed to connect",
    "Traceback (most recent call last):",
    "done (exit 1)",
  ])("is a failure: %s", (s) => {
    expect(isFailureResult(s)).toBe(true);
  });

  it.each([
    "No matches",
    "README: how we handle errors",
    "terror: inside a longer word",
    "exit 0",
  ])("is not a failure: %s", (s) => {
    expect(isFailureResult(s)).toBe(false);
  });

  it("has no control characters in its source", () => {
    expect(/[\x00-\x08]/.test(isFailureResult.toString())).toBe(false);
  });
});
