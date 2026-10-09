import { describe, it, expect, vi, beforeAll } from "vitest";

// Mock config with low threshold before importing compression
vi.mock("../../../src/config.js", () => ({
  config: { compressAfterTokens: 0, sessionsDir: "/tmp/test-sessions" },
}));

import { summarizeToolResult, compressContext } from "../../../src/agent/compression.js";

describe("summarizeToolResult", () => {
  it("summarizes read_file", () => {
    const content = "line1\nline2\nline3";
    const result = summarizeToolResult(content, "read_file", { path: "src/index.js" });
    expect(result).toContain("[Read src/index.js");
    expect(result).toContain("3 lines");
    expect(result).toContain("line1");
  });

  it("summarizes run_command", () => {
    const content = "exited exit code 0\noutput line";
    const result = summarizeToolResult(content, "run_command", { command: "npm test" });
    expect(result).toContain("[Ran 'npm test'");
    expect(result).toContain("exit 0");
  });

  it("summarizes search_in_files", () => {
    const content = "Found 3 matches:\nsrc/a.js:10: foo\nsrc/a.js:20: bar\nsrc/b.js:5: baz";
    const result = summarizeToolResult(content, "search_in_files", { pattern: "foo" });
    expect(result).toContain("[Search /foo/");
    expect(result).toContain("3 matches");
    expect(result).toContain("2 files");
  });

  it("summarizes think", () => {
    const content = "Let me analyze this problem carefully";
    const result = summarizeToolResult(content, "think", {});
    expect(result).toContain("[Thought:");
    expect(result).toContain("Let me analyze");
  });

  it("summarizes list_directory", () => {
    const content = "src/\npackage.json\nREADME.md\nnode_modules/";
    const result = summarizeToolResult(content, "list_directory", { path: "." });
    expect(result).toContain("[Listed .");
    expect(result).toContain("4 items");
  });

  it("summarizes unknown tool with default format", () => {
    const content = "some result";
    const result = summarizeToolResult(content, "custom_tool", {});
    expect(result).toContain("[custom_tool(...)");
    expect(result).toContain("1 lines");
  });
});

describe("compressHeadTail (via compressContext)", () => {
  it("compresses previous iteration messages with headtail", async () => {
    // Need >500 chars and >13 lines to trigger headtail compression
    const longContent = Array.from({ length: 20 }, (_, i) => `line ${i} ${"x".repeat(30)}`).join("\n");
    const messages = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "ok", tool_calls: [{ id: "1", function: { name: "read_file" } }] },
      { role: "tool", tool_call_id: "1", content: longContent, _toolName: "read_file", _toolArgs: { path: "f.txt" } },
      // current iteration starts here
      { role: "user", content: "next" },
    ];
    // i=2 is >= prevIterationStart(0) and < iterationStart(3) → age=1
    // content.length > 500 → headtail compression
    const saved = await compressContext(messages, 0, 3, null, { forceCompress: true });
    expect(messages[2]._compressed).toBe("headtail");
    expect(messages[2].content).toContain("omitted");
  });

  it("summarizes old iteration messages (age>=2)", async () => {
    const longContent = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    const messages = [
      { role: "tool", tool_call_id: "1", content: longContent, _toolName: "read_file", _toolArgs: { path: "f.txt" } },
      // prev iteration boundary
      { role: "tool", tool_call_id: "2", content: "short", _toolName: "think", _toolArgs: {} },
      // current iteration boundary
      { role: "user", content: "now" },
    ];
    await compressContext(messages, 1, 2, null, { forceCompress: true });
    // msg[0] is age>=2 (i < prevIterationStart=1) → summary
    expect(messages[0]._compressed).toBe("summary");
    expect(messages[0].content).toContain("[Read f.txt");
  });

  it("compresses short tool messages via head-tail when forced", async () => {
    const messages = [
      { role: "tool", tool_call_id: "1", content: "short text", _toolName: "think", _toolArgs: {} },
      { role: "user", content: "ok" },
    ];
    await compressContext(messages, 0, 1, null, { forceCompress: true });
    // Current behavior: short tool messages also go through head-tail compression
    expect(messages[0]._compressed).toBe("headtail");
  });
});

// With swap on, tool results are swap's to move. A result cut here cannot be
// read back, so compression leaves them whole and still does the rest.
describe("with keepToolResults (swap is on)", () => {
  const long = Array.from({ length: 40 }, (_, i) => `line ${i} of the file, long enough to matter`).join("\n");

  it("leaves a tool result of the previous call and an older one whole", async () => {
    const messages = [
      { role: "tool", tool_call_id: "1", content: long, _toolName: "read_file", _toolArgs: { path: "old.txt" } },
      { role: "tool", tool_call_id: "2", content: long, _toolName: "read_file", _toolArgs: { path: "prev.txt" } },
      { role: "user", content: "now" },
    ];
    await compressContext(messages, 1, 2, null, { forceCompress: true, keepToolResults: true });
    expect(messages[0].content).toBe(long);
    expect(messages[1].content).toBe(long);
    expect(messages[0]._compressed).toBeUndefined();
    expect(messages[1]._compressed).toBeUndefined();
  });

  it("still turns an old screenshot into its text", async () => {
    const messages = [
      {
        role: "user", _isImage: true, _imageTool: "desktop_screenshot", _imagePath: "shot.png",
        content: [{ type: "text", text: "a window with a table" }, { type: "image_url", image_url: { url: "data:image/png;base64,abc" } }],
      },
      { role: "user", content: "next" },
    ];
    await compressContext(messages, 0, 1, null, { forceCompress: true, keepToolResults: true });
    expect(typeof messages[0].content).toBe("string");
    expect(messages[0].content).toContain("Image from desktop_screenshot");
  });
});

describe("image message compression", () => {
  it("compresses image_url messages to text", async () => {
    const messages = [
      {
        role: "user",
        _isImage: true,  // flag set by agent.js for deferred compression
        _imageTool: "desktop_screenshot",
        _imagePath: "test.png",
        content: [
          { type: "text", text: "[Tool result image from \"desktop_screenshot\". Analyze and act.]" },
          { type: "image_url", image_url: { url: "data:image/png;base64,abc..." } },
        ],
      },
      { role: "user", content: "next" },
    ];
    await compressContext(messages, 0, 1, null, { forceCompress: true });
    expect(messages[0]._compressed).toBe(true);
    expect(typeof messages[0].content).toBe("string");
    expect(messages[0].content).toContain("Image from desktop_screenshot");
  });
});

// The threshold was checked against chars/4 of the messages alone, which leaves
// out the system prompt and tool schemas (about 18K per call in a real session)
// and undercounts code and non-English text. A 1572-call session ran 784 calls
// above the 128K normal-level cap. The provider's own prompt_tokens from the
// last call is the honest size of what is being sent, so it counts too.
describe("threshold uses the provider's real prompt size", () => {
  const build = () => ([
    { role: "tool", tool_call_id: "1", content: Array.from({ length: 20 }, (_, i) => `line ${i} ${"x".repeat(30)}`).join(String.fromCharCode(10)), _toolName: "read_file", _toolArgs: { path: "f.txt" } },
    { role: "user", content: "next" },
  ]);

  it("compresses when the real prompt is over the threshold though the messages look small", async () => {
    const messages = build();
    await compressContext(messages, 0, 1, null, { contextTokens: 200000 });
    expect(messages[0]._compressed).toBeTruthy();
  });

  it("does not compress when both the estimate and the real prompt are under the threshold", async () => {
    const messages = build();
    await compressContext(messages, 0, 1, null, { contextTokens: 5000 });
    expect(messages[0]._compressed).toBeFalsy();
  });
});
