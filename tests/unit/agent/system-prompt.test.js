import { describe, it, expect, vi, afterEach } from "vitest";
import { getSystemMessage } from "../../../src/agent/system-prompt.js";
import { config } from "../../../src/config.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("getSystemMessage()", () => {
  it("returns object with role system", () => {
    const msg = getSystemMessage();
    expect(msg.role).toBe("system");
  });

  it("loads content from system.md", () => {
    const msg = getSystemMessage();
    expect(msg.content).toContain("FLINT");
    expect(msg.content).toContain("Core Principles");
  });

  it("contains Intent Layer guidance from system.md", () => {
    const msg = getSystemMessage();
    expect(msg.content).toContain("Intent Layer");
    expect(msg.content).toContain("intent");
  });

  it("names the folder the agent works in, and reads FLINT.md from it", () => {
    // Flint runs from its own install folder; the agent works in config.baseDir.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flint-work-"));
    const saved = config.baseDir;
    try {
      fs.writeFileSync(path.join(dir, "FLINT.md"), "Project note: the deploy host is zz-test-host.", "utf-8");
      config.baseDir = dir;
      const text = getSystemMessage().content;
      expect(text).toContain("CWD: " + dir);
      expect(text).toContain("zz-test-host");
    } finally {
      config.baseDir = saved;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("contains environment info", () => {
    const msg = getSystemMessage();
    expect(msg.content).toContain("CWD:");
  });

  it("does not change when only the clock moves, and says how to get the time", () => {
    // The clock sat at the end of the system prompt. On a model whose template
    // renders the tools AFTER the system message, a line that changes every
    // minute there leaves the tools and the request uncached on every new
    // task: a 2026-09-29 benchmark run cached 4096-6144 of ~7500 prompt tokens on
    // Flint's first calls, a reference agent (no clock in its prompt) ~99%, and Flint
    // paid 2.3x on the same tasks. The agent still gets the time, the way
    // other agents do: by asking the system when it needs it.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-29T03:04:00"));
    const a = getSystemMessage(null, { intentClass: "complex_multi" }).content;
    vi.setSystemTime(new Date("2026-09-30T11:47:00"));
    const b = getSystemMessage(null, { intentClass: "complex_multi" }).content;
    expect(b).toBe(a);
    expect(a).toMatch(/current date|current time/i);
  });

  it("is byte-identical up to the dynamic boundary when only the clock and the intent class move", () => {
    // The layout already promises this: the sections are labelled FIXED,
    // SESSION-STABLE ZONE (cached across turns) and PER-TURN ZONE, with
    // __DYNAMIC_BOUNDARY__ written into the prompt to mark where the stable
    // part ends. The zone called fixed was not: it carried a clock with
    // minute resolution and the intent-specific mode block, so the prefix
    // every later token is cached against changed every minute and on every
    // change of intent.
    //
    // Measured on the readiness run of 2026-09-21, 134 calls in one session:
    // the first and last system prompts shared 22 936 of 28 618 characters,
    // and 57 408 of 1 441 137 prompt tokens were read from cache.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-21T20:30:00"));
    const a = getSystemMessage(null, { intentClass: "complex_multi" }).content;
    vi.setSystemTime(new Date("2026-09-21T20:47:00"));
    const b = getSystemMessage(null, { intentClass: "shell_command" }).content;

    const boundary = a.indexOf("__DYNAMIC_BOUNDARY__");
    expect(boundary, "the prompt no longer marks where its stable part ends").toBeGreaterThan(0);
    expect(b.slice(0, boundary)).toBe(a.slice(0, boundary));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("prompt is file-based, not hardcoded", () => {
    const fs = require("fs");
    const source = fs.readFileSync("src/agent/system-prompt.js", "utf-8");
    // Core prompt should come from file, not inline strings
    expect(source).toContain("loadSystemMd()");
    expect(source).not.toContain("CORE PRINCIPLES:");
  });
});
