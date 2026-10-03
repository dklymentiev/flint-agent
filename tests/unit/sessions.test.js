import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTmpDir } from "../helpers/tmp-dir.js";
import fs from "node:fs";
import path from "node:path";

// Mock config to use tmp sessions dir
let tmp;
let sessionsDir;

vi.mock("../../src/config.js", () => {
  return {
    config: {
      get sessionsDir() {
        return globalThis.__testSessionsDir;
      },
    },
  };
});

const { generateSessionId, saveSession, loadSession, listSessions } = await import("../../src/sessions.js");

beforeEach(() => {
  tmp = createTmpDir();
  sessionsDir = path.join(tmp.path, "sessions");
  fs.mkdirSync(sessionsDir);
  globalThis.__testSessionsDir = sessionsDir;
});

afterEach(() => {
  tmp.cleanup();
});

describe("generateSessionId", () => {
  it("returns ISO-like format with dashes", () => {
    const id = generateSessionId();
    // Format: 2026-02-23T05-11-46
    expect(id).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/);
  });
});

describe("saveSession → loadSession roundtrip", () => {
  it("saves and loads matching data", async () => {
    const messages = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ];
    await saveSession("test-001", {
      messages,
      model: "gpt-4o",
      inputHistory: ["hello"],
    });
    const loaded = await loadSession("test-001");
    expect(loaded.id).toBe("test-001");
    expect(loaded.model).toBe("gpt-4o");
    expect(loaded.messages).toEqual(messages);
    expect(loaded.inputHistory).toEqual(["hello"]);
    expect(loaded.updated).toBeDefined();
  });
});

describe("listSessions", () => {
  it("returns sessions sorted by updated desc", async () => {
    await saveSession("session-a", {
      messages: [{ role: "user", content: "first session" }],
      model: "m1",
    });
    // Small delay to ensure different timestamps
    await new Promise((r) => setTimeout(r, 50));
    await saveSession("session-b", {
      messages: [{ role: "user", content: "second session" }],
      model: "m2",
    });
    const sessions = await listSessions();
    expect(sessions).toHaveLength(2);
    expect(sessions[0].id).toBe("session-b");
    expect(sessions[1].id).toBe("session-a");
  });

  it("returns empty array for missing dir", async () => {
    globalThis.__testSessionsDir = path.join(tmp.path, "nonexistent");
    const sessions = await listSessions();
    expect(sessions).toEqual([]);
  });
});

describe("loadSession — not found", () => {
  it("throws for missing session", async () => {
    await expect(loadSession("nonexistent")).rejects.toThrow();
  });
});
