import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { createTmpDir } from "../../helpers/tmp-dir.js";

let tmp;
const mockConfig = {};

vi.mock("../../../src/config.js", () => ({
  config: mockConfig,
}));

let appendDigestEntry, loadDigest, getDigestForPrompt, clearDigest;

beforeEach(async () => {
  tmp = createTmpDir();
  mockConfig.projectRoot = tmp.path;
  mockConfig.sessionsDir = path.join(tmp.path, "sessions");
  vi.resetModules();
  const mod = await import("../../../src/memory/conversation-digest.js");
  appendDigestEntry = mod.appendDigestEntry;
  loadDigest = mod.loadDigest;
  getDigestForPrompt = mod.getDigestForPrompt;
  clearDigest = mod.clearDigest;
});

afterEach(() => {
  tmp.cleanup();
});

const SESSION = "digest-test-001";

describe("appendDigestEntry", () => {
  it("creates file and appends first entry", () => {
    appendDigestEntry(SESSION, {
      userMessage: "Hello agent",
      assistantResponse: "Hi! How can I help?",
      toolsUsed: [],
    });
    const entries = loadDigest(SESSION);
    expect(entries).toHaveLength(1);
    expect(entries[0].turn).toBe(1);
    expect(entries[0].user).toBe("Hello agent");
    expect(entries[0].assistant).toBe("Hi! How can I help?");
  });

  it("appends multiple entries with incrementing turn numbers", () => {
    appendDigestEntry(SESSION, {
      userMessage: "First message",
      assistantResponse: "First response",
    });
    appendDigestEntry(SESSION, {
      userMessage: "Second message",
      assistantResponse: "Second response",
      toolsUsed: ["file_read", "file_write"],
    });
    const entries = loadDigest(SESSION);
    expect(entries).toHaveLength(2);
    expect(entries[0].turn).toBe(1);
    expect(entries[1].turn).toBe(2);
    expect(entries[1].tools).toEqual(["file_read", "file_write"]);
  });
});

describe("loadDigest", () => {
  it("loads all entries from JSONL", () => {
    appendDigestEntry(SESSION, { userMessage: "a", assistantResponse: "b" });
    appendDigestEntry(SESSION, { userMessage: "c", assistantResponse: "d" });
    appendDigestEntry(SESSION, { userMessage: "e", assistantResponse: "f" });
    const entries = loadDigest(SESSION);
    expect(entries).toHaveLength(3);
  });

  it("empty/missing file returns []", () => {
    expect(loadDigest("nonexistent")).toEqual([]);
  });
});

describe("getDigestForPrompt", () => {
  beforeEach(() => {
    for (let i = 1; i <= 5; i++) {
      appendDigestEntry(SESSION, {
        userMessage: `msg ${i}`,
        assistantResponse: `resp ${i}`,
        toolsUsed: i === 3 ? ["search"] : [],
      });
    }
  });

  it("formats last N turns for system prompt", () => {
    const prompt = getDigestForPrompt(SESSION);
    expect(prompt).toContain("Conversation digest (5 turns, showing last 5)");
    expect(prompt).toContain('Turn 1: "msg 1"');
    expect(prompt).toContain('Turn 5: "msg 5"');
    expect(prompt).toContain("[search]");
  });

  it("maxEntries limits output to most recent turns", () => {
    const prompt = getDigestForPrompt(SESSION, 2);
    expect(prompt).toContain("showing last 2");
    expect(prompt).not.toContain("Turn 1:");
    expect(prompt).toContain("Turn 4:");
    expect(prompt).toContain("Turn 5:");
  });

  it("returns empty string for missing session", () => {
    expect(getDigestForPrompt("no-session")).toBe("");
  });
});

describe("clearDigest", () => {
  it("removes digest file content", () => {
    appendDigestEntry(SESSION, { userMessage: "x", assistantResponse: "y" });
    clearDigest(SESSION);
    const entries = loadDigest(SESSION);
    expect(entries).toEqual([]);
  });
});

describe("HMAC verification", () => {
  it("tampered digest returns empty on load", () => {
    appendDigestEntry(SESSION, { userMessage: "legit", assistantResponse: "ok" });

    // Tamper with digest file
    const digestFile = path.join(tmp.path, "sessions", `${SESSION}.digest.jsonl`);
    const data = readFileSync(digestFile, "utf-8");
    writeFileSync(digestFile, data.replace("legit", "INJECTED"), "utf-8");

    const entries = loadDigest(SESSION);
    expect(entries).toEqual([]);
  });
});
