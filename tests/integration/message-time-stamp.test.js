// The local date and time go into each message the operator sends, not into
// the system prompt (owner, 2026-10-02: documents dated 2026-09-30 on
// 2026-10-02). Written once, so the history a later call sends is the same
// bytes and the provider's prompt cache keeps working.
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../../src/logging/logger.js", () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}));

const { messageTimeStamp, withTimeStamp, stripTimeStamp } = await import("../../src/agent/time-stamp.js");

describe("the stamp", () => {
  it("names the day, date, time and offset", () => {
    expect(messageTimeStamp(new Date(2026, 9, 2, 10, 16))).toMatch(/^\[Local time: Fri 2026-10-02 10:16( \S+)?, UTC[+-]\d\d:\d\d\]$/);
  });

  it("goes first, whether the message is text or parts, and comes off again", () => {
    const d = new Date(2026, 9, 2, 10, 16);
    const text = withTimeStamp("write the plan", d);
    expect(text.split("\n")[1]).toBe("write the plan");
    expect(stripTimeStamp(text)).toBe("write the plan");
    const parts = withTimeStamp([{ type: "text", text: "look" }, { type: "image_url", image_url: { url: "x" } }], d);
    expect(parts[0].text).toMatch(/^\[Local time: /);
    expect(parts[1]).toEqual({ type: "text", text: "look" });
  });
});

describe("a turn", () => {
  afterEach(() => vi.restoreAllMocks());

  it("sends the stamp in the new message, keeps it out of the system prompt, and never rewrites it", async () => {
    const sent = [];
    const agent = await import("../../src/agent/agent.js");
    vi.spyOn(agent, "runAgent").mockImplementation(async (messages) => {
      sent.push(JSON.parse(JSON.stringify(messages)));
      messages.push({ role: "assistant", content: "ok" });
      return { text: "ok", stats: { generationIds: [] } };
    });
    const { processMessage } = await import("../../src/message-handler.js");
    await processMessage("first question", null);
    await new Promise((r) => setTimeout(r, 1100));   // a later moment
    await processMessage("second question", null);

    const users = (call) => call.filter((m) => m.role === "user");
    const first = users(sent[0]).at(-1);
    expect(first.content).toMatch(/^\[Local time: .+\]\nfirst question$/);
    // No actual stamp in the system prompt (system.md names the format, so
    // look for a date in it).
    const STAMP = /\[Local time: \w{3} \d{4}-\d\d-\d\d/;
    for (const m of sent[0].filter((x) => x.role === "system")) expect(String(m.content)).not.toMatch(STAMP);
    const { buildSystemMessage } = await import("../../src/bootstrap.js");
    expect(JSON.stringify(buildSystemMessage("generic"))).not.toMatch(STAMP);
    // The second turn sends the first message exactly as the first turn did.
    const again = users(sent[1]).find((m) => String(m.content).endsWith("first question"));
    expect(again.content).toBe(first.content);
    expect(users(sent[1]).at(-1).content).toMatch(/^\[Local time: .+\]\nsecond question$/);
  }, 30000);
});

