import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTmpDir } from "../helpers/tmp-dir.js";
import fs from "node:fs";
import path from "node:path";

let tmp;
let sessionsDir;

vi.mock("../../src/config.js", () => ({
  config: {
    get sessionsDir() {
      return globalThis.__testSessionsDir;
    },
  },
}));

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

describe("session roundtrip integration", () => {
  it("full roundtrip: create → save → load → verify", async () => {
    const messages = [
      { role: "system", content: "You are helpful" },
      { role: "user", content: "What is 2+2?" },
      { role: "assistant", content: "4" },
      { role: "user", content: "Thanks" },
      { role: "assistant", content: "You're welcome!" },
    ];
    const inputHistory = ["What is 2+2?", "Thanks"];
    const model = "google/gemini-2.0-flash-001";
    const sessionId = "test-roundtrip-001";

    // Save
    await saveSession(sessionId, { messages, model, inputHistory });

    // Load
    const loaded = await loadSession(sessionId);

    // Verify complete match
    expect(loaded.id).toBe(sessionId);
    expect(loaded.model).toBe(model);
    expect(loaded.messages).toEqual(messages);
    expect(loaded.inputHistory).toEqual(inputHistory);
    expect(loaded.updated).toBeDefined();

    // List should contain this session
    const sessions = await listSessions();
    expect(sessions.some((s) => s.id === sessionId)).toBe(true);
    const found = sessions.find((s) => s.id === sessionId);
    expect(found.model).toBe(model);
    expect(found.preview).toContain("What is 2+2?");
  });

  it("multiple sessions saved and listed correctly", async () => {
    for (let i = 0; i < 3; i++) {
      await saveSession(`session-${i}`, {
        messages: [{ role: "user", content: `Message ${i}` }],
        model: "test-model",
        inputHistory: [],
      });
      // Small delay so timestamps differ
      await new Promise((r) => setTimeout(r, 20));
    }

    const sessions = await listSessions();
    expect(sessions).toHaveLength(3);
    // Should be sorted newest first
    expect(sessions[0].id).toBe("session-2");
    expect(sessions[2].id).toBe("session-0");
  });

  it("handles session with tool messages and metadata", async () => {
    const messages = [
      { role: "system", content: "System prompt" },
      { role: "user", content: "Read a file" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{
          id: "call_1",
          type: "function",
          function: { name: "read_file", arguments: '{"path":"test.txt"}' },
        }],
      },
      {
        role: "tool",
        tool_call_id: "call_1",
        content: "file content",
        _toolName: "read_file",
        _toolArgs: { path: "test.txt" },
      },
      { role: "assistant", content: "The file contains: file content" },
    ];

    await saveSession("tool-session", { messages, model: "gpt-4o", inputHistory: ["Read a file"] });
    const loaded = await loadSession("tool-session");
    expect(loaded.messages).toHaveLength(5);
    expect(loaded.messages[3]._toolName).toBe("read_file");
    expect(loaded.messages[2].tool_calls).toHaveLength(1);
  });
});
