// Conversation swap and when swap wakes up (docs/context-swap.md, B1, B3,
// C1-C4).
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createSwapStore, swapFromTokens, swapActive, contextTokensOf,
  convSettings, turnsOf, planConversationSwap, transcriptOf, applyConversationSwap, stubFor,
} from "../../../src/agent/swap.js";

let dir;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "flint-conv-")); });

const words = (n, tag) => (`${tag} `).repeat(Math.ceil(n / (tag.length + 1))).trim();
/** A talk of `turns` turns; each turn ~`tokens` tokens; every third turn has a tool call. */
function talk(turns, tokens = 6000) {
  const m = [{ role: "system", content: "You are FLINT." }];
  for (let t = 1; t <= turns; t++) {
    m.push({ role: "user", content: `[Local time: Fri 2026-10-02 ${String(8 + Math.floor(t / 6)).padStart(2, "0")}:${String((t * 7) % 60).padStart(2, "0")} CDT, UTC-05:00]\nquestion ${t}: ${words(tokens * 2, `q${t}`)}` });
    if (t % 3 === 0) {
      m.push({ role: "assistant", content: "", tool_calls: [{ id: `tc${t}`, type: "function", function: { name: "read_file", arguments: `{"path":"f${t}.txt"}` } }] });
      m.push({ role: "tool", tool_call_id: `tc${t}`, content: `<tool_result name="read_file">\nfile ${t}\n</tool_result>`, _toolName: "read_file" });
    }
    m.push({ role: "assistant", content: `answer ${t}: ${words(tokens * 2, `a${t}`)}` });
  }
  return m;
}

describe("when swap wakes up (B1, B3)", () => {
  it("swapFrom is 75% of the compression threshold, or FLINT_SWAP_FROM", () => {
    expect(swapFromTokens({ env: {}, compressThreshold: 128000 })).toBe(96000);
    expect(swapFromTokens({ env: {}, compressThreshold: 64000 })).toBe(48000);
    expect(swapFromTokens({ env: { FLINT_SWAP_FROM: "20000" }, compressThreshold: 128000 })).toBe(20000);
  });

  it("is active only at or above swapFrom", () => {
    expect(swapActive(47999, 48000)).toBe(false);
    expect(swapActive(48000, 48000)).toBe(true);
  });

  it("measures the context the way the budget does (characters / 4, tool calls included)", () => {
    const m = [{ role: "user", content: "x".repeat(400) }, { role: "assistant", content: "", tool_calls: [{ id: "a", function: { name: "f", arguments: "{}" } }] }];
    expect(contextTokensOf(m)).toBe(100 + Math.ceil(JSON.stringify(m[1].tool_calls).length / 4));
  });
});

describe("conversation swap", () => {
  it("settings follow the window: half of it up to 128k at level normal, a third of that per chunk, 4 turns kept", () => {
    expect(convSettings({ env: {}, window: 1_000_000, level: "normal" })).toEqual({ high: 128000, chunk: 42666, keepTurns: 4 });
    expect(convSettings({ env: {}, window: 200_000, level: "normal" })).toEqual({ high: 100000, chunk: 33333, keepTurns: 4 });
    expect(convSettings({ env: {}, window: null, level: "normal" })).toEqual({ high: 64000, chunk: 21333, keepTurns: 4 });
    expect(convSettings({ env: { FLINT_SWAP_CONV_HIGH: "50000" }, window: null })).toMatchObject({ high: 50000, chunk: 16666 });
  });

  it("a turn is the operator's message and everything up to the next one", () => {
    const m = talk(3);
    const turns = turnsOf(m);
    expect(turns.map((t) => [m[t.start].role, t.end - t.start])).toEqual([["user", 2], ["user", 2], ["user", 4]]);
  });

  it("C1 plans nothing under convHigh, and the oldest whole turns over it, never the latest ones", () => {
    const m = talk(30);                                    // ~180k tokens
    expect(planConversationSwap(m, { high: 1_000_000, chunk: 50000, keepTurns: 4 })).toBeNull();
    const plan = planConversationSwap(m, { high: 100000, chunk: 50000, keepTurns: 4 });
    const turns = turnsOf(m);
    expect(plan.start).toBe(turns[0].start);
    expect(turns.some((t) => t.end === plan.end)).toBe(true);         // ends on a turn boundary
    expect(contextTokensOf(m.slice(plan.start, plan.end))).toBeGreaterThanOrEqual(50000);
    expect(plan.end).toBeLessThanOrEqual(turns.at(-4).start);         // the last 4 turns stay
  });

  it("C2/C3 moves the turns to one entry and leaves one line after the system message, with the model's summary", async () => {
    const m = talk(30);
    const before = m.slice();
    const store = createSwapStore(dir);
    const e = await applyConversationSwap(m, store, { high: 100000, chunk: 50000, keepTurns: 4 }, async () => "Questions 1 to 9 about q-words, answered.");
    expect(e.kind).toBe("conversation");
    expect(e.title).toBe("Questions 1 to 9 about q-words, answered.");
    expect(m[0]).toBe(before[0]);
    expect(m[1]).toMatchObject({ role: "system", content: stubFor(e), _swap: e.id });
    expect(e.source).toMatch(/^turns 1-\d+, 08:07-\d\d:\d\d$/);
    const text = store.read(e.id);
    expect(text).toContain("question 1:");
    expect(text).toContain("answer 1:");
    expect(text).toContain("read_file");                               // the tool call and its result went too
    // No tool result is left without the call it answers.
    const callIds = new Set(m.flatMap((x) => (x.tool_calls || []).map((c) => c.id)));
    for (const x of m.filter((y) => y.role === "tool")) expect(callIds.has(x.tool_call_id)).toBe(true);
  });

  it("C3 without a summary, the line lists the first words of the operator's messages", async () => {
    const m = talk(30);
    const store = createSwapStore(dir);
    const e = await applyConversationSwap(m, store, { high: 100000, chunk: 50000, keepTurns: 4 }, async () => { throw new Error("no model"); });
    expect(e.title).toMatch(/^question 1: .*question 2:/);
  });

  it("a second chunk goes after the first line, so the top reads in order", async () => {
    const m = talk(40);
    const store = createSwapStore(dir);
    const opts = { high: 100000, chunk: 50000, keepTurns: 4 };
    const e1 = await applyConversationSwap(m, store, opts, async () => "first");
    const e2 = await applyConversationSwap(m, store, opts, async () => "second");
    expect(m[1].content).toBe(stubFor(e1));
    expect(m[2].content).toBe(stubFor(e2));
    expect(transcriptOf([{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }])).toBe("USER: hi\n\nASSISTANT: hello");
  });

  it("C4 a 60-turn talk stays under convHigh plus one turn, and nothing is lost", async () => {
    const store = createSwapStore(dir);
    const opts = { high: 100000, chunk: 33000, keepTurns: 4 };
    const full = talk(60);
    const m = [full[0]];
    let i = 1;
    let turn = 0;
    while (i < full.length) {
      // One turn arrives; at its start the conversation swap runs.
      let j = i + 1;
      while (j < full.length && full[j].role !== "user") j++;
      m.push(...full.slice(i, j));
      turn++;
      await applyConversationSwap(m, store, opts, async () => `chunk before turn ${turn}`);
      expect(contextTokensOf(m), `turn ${turn}`).toBeLessThanOrEqual(opts.high + 8000);
      i = j;
    }
    const entries = store.list().reverse();
    expect(entries.length).toBeGreaterThan(3);
    expect(store.read(entries[0].id)).toContain("question 1:");
    // Every question is either still in the talk or in the store.
    for (let t = 1; t <= 60; t++) {
      const inTalk = m.some((x) => x.role === "user" && String(x.content).includes(`question ${t}:`));
      const inStore = entries.some((e) => store.read(e.id).includes(`question ${t}:`));
      expect(inTalk || inStore, `question ${t}`).toBe(true);
    }
  });
});

describe("what the summary is given", () => {
  it("the head of every message in the chunk, so a long one does not crowd out the rest", async () => {
    let given = "";
    const m = talk(30);
    const store = createSwapStore(dir);
    await applyConversationSwap(m, store, { high: 100000, chunk: 50000, keepTurns: 4 }, async (text) => { given = text; return "s"; });
    const entry = store.list()[0];
    const turnsMoved = Number(entry.source.match(/turns 1-(\d+)/)[1]);
    for (let t = 1; t <= turnsMoved; t++) expect(given, `turn ${t}`).toContain(`question ${t}:`);
  });
});
