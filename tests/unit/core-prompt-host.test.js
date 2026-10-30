// --core-prompt host: Flint run by a host program gets system.md without the
// parts written for Flint on its own (marked interactive). Without the flag
// nothing changes, and the marker lines never reach the model in either mode.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseStdioArgs, parseCorePrompt } from "../../src/stdio/args.js";
import { corePromptText } from "../../src/agent/system-prompt.js";

const systemMd = readFileSync(new URL("../../system.md", import.meta.url), "utf-8");

describe("--core-prompt", () => {
  it("is full when not given, and takes full or host", () => {
    expect(parseCorePrompt(undefined)).toBe("full");
    expect(parseCorePrompt("full")).toBe("full");
    expect(parseCorePrompt("host")).toBe("host");
  });

  it("refuses any other value instead of quietly running with the full prompt", () => {
    expect(() => parseCorePrompt("short")).toThrow(/full or host/);
    expect(() => parseCorePrompt("")).toThrow(/full or host/);
  });

  it("is read from a stdio command line, in both flag forms", () => {
    const base = ["node", "flint", "--print", "--input-format", "stream-json"];
    expect(parseStdioArgs(base).corePrompt).toBe("full");
    expect(parseStdioArgs([...base, "--core-prompt", "host"]).corePrompt).toBe("host");
    expect(parseStdioArgs([...base, "--core-prompt=host"]).corePrompt).toBe("host");
  });
});

describe("system.md by core prompt", () => {
  it("has its interactive part marked, so host mode has something to leave out", () => {
    expect(systemMd).toContain("<!-- interactive -->");
    expect(systemMd).toContain("<!-- /interactive -->");
  });

  it("full: every line but the markers", () => {
    const full = corePromptText(systemMd, "full");
    expect(full).not.toContain("<!--");
    expect(full).toContain("restart_agent");
    const markers = systemMd.split("\n").filter((l) => l.trim().startsWith("<!--")).length;
    expect(full.split("\n").length).toBe(systemMd.split("\n").length - markers);
  });

  it("host: the interactive part is left out and everything else stays", () => {
    const host = corePromptText(systemMd, "host");
    expect(host).not.toContain("<!--");
    expect(host).not.toContain("restart_agent");
    for (const kept of ["## Core Principles", "## When something fails", "## Security", "tool_search", "swap_read"]) {
      expect(host, kept).toContain(kept);
    }
  });
});
