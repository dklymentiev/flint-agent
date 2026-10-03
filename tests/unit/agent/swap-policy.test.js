// Context swap: what is swapped, when, and what stays in its place
// (docs/context-swap.md, A6, A7, A8).
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  swapEnabled, swapSettings, kindOf, sourceOf, titleOf, outlineOf, stubFor, arrivalView,
  createSwapStore, planEviction, applySwap, readableOf,
} from "../../../src/agent/swap.js";

const wrap = (name, text) => `<tool_result name="${name}">\n${text}\n</tool_result>`;
const big = (n, kb = 11) => `# Page ${n}\n\n` + `word${n} `.repeat(Math.ceil((kb * 1024) / 6));

/** A conversation: system, then per turn a user message, `calls` tool calls with results, an answer. */
function conversation({ turns = 1, calls = 4, kb = 11 } = {}) {
  const m = [{ role: "system", content: "You are FLINT." }];
  let n = 0;
  for (let t = 0; t < turns; t++) {
    m.push({ role: "user", content: `read pages, turn ${t + 1}` });
    for (let c = 0; c < calls; c++) {
      n++;
      const id = `c${n}`;
      m.push({ role: "assistant", content: "", tool_calls: [{ id, type: "function", function: { name: "web_fetch", arguments: JSON.stringify({ url: `https://example.com/p${n}` }) } }] });
      m.push({ role: "tool", tool_call_id: id, content: wrap("web_fetch", big(n, kb)), _toolName: "web_fetch", _toolArgs: { url: `https://example.com/p${n}` } });
    }
  }
  return m;
}
const toolTokens = (m) => m.filter((x) => x.role === "tool").reduce((s, x) => s + Math.ceil(String(x.content).length / 4), 0);

let dir;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "flint-swap-")); });

describe("settings", () => {
  it("is on unless FLINT_SWAP=0, with the documented defaults", () => {
    expect(swapEnabled({})).toBe(true);
    expect(swapEnabled({ FLINT_SWAP: "0" })).toBe(false);
    expect(swapSettings({})).toEqual({ resultMax: 4096, budgetTokens: 16000, lowWater: 0.6, minBytes: 1024, headBytes: 1500 });
    expect(swapSettings({ FLINT_SWAP_BUDGET: "1000", FLINT_SWAP_RESULT_MAX: "100", FLINT_SWAP_LOW_WATER: "0.5" }))
      .toMatchObject({ budgetTokens: 1000, resultMax: 100, lowWater: 0.5 });
  });
});

describe("a browser tool's JSON answer", () => {
  it("gives its page text, URL and title, and anything else stays as it is", () => {
    const page = "1\nFrom Wikipedia\n## History";
    const raw = JSON.stringify({ chars: 15000, selector: "#content", text: page, title: "1 - Wikipedia", url: "https://en.wikipedia.org/wiki/1" }, null, 2);
    expect(readableOf(raw)).toEqual({ text: page, url: "https://en.wikipedia.org/wiki/1", title: "1 - Wikipedia" });
    expect(readableOf("plain text")).toEqual({ text: "plain text", url: "", title: "" });
    expect(readableOf('{"success": true}')).toEqual({ text: '{"success": true}', url: "", title: "" });
    expect(readableOf("{ not json")).toEqual({ text: "{ not json", url: "", title: "" });
  });
});

describe("describing a result", () => {
  it("kind and source from the tool and its arguments", () => {
    expect(kindOf("web_fetch")).toBe("page");
    expect(kindOf("mcp_remote_desktop_chrome")).toBe("page");
    expect(kindOf("read_file")).toBe("file");
    expect(kindOf("run_command")).toBe("command");
    expect(kindOf("web_search")).toBe("search");
    expect(kindOf("search_in_files")).toBe("search");
    expect(kindOf("list_goals")).toBe("other");
    expect(sourceOf("web_fetch", { url: "https://a.b/c" })).toBe("https://a.b/c");
    expect(sourceOf("read_file", { path: "src/x.js" })).toBe("src/x.js");
    expect(sourceOf("run_command", { command: "npm test" })).toBe("npm test");
    expect(sourceOf("web_search", { query: "openai dots" })).toBe("openai dots");
    expect(sourceOf("other", {})).toBe("");
  });

  it("title and outline from the text", () => {
    expect(titleOf("\n\n# Manage dots\nbody")).toBe("Manage dots");
    expect(titleOf("first line\nsecond")).toBe("first line");
    expect(titleOf("x".repeat(300)).length).toBe(100);
    expect(outlineOf("# A\ntext\n## B\n<h2>C</h2>\n#not a heading", 10)).toEqual(["# A", "## B", "C"]);
  });

  it("the stub names everything needed to read it back, and is the same bytes every time (A7)", () => {
    const e = { id: 37, kind: "page", source: "https://help.example.com/manage-dots", bytes: 11468, title: "Manage dots in workspaces", turn: 12 };
    const s = stubFor(e);
    expect(s).toBe('[swap #37 · page · https://help.example.com/manage-dots · 11.2 KB · "Manage dots in workspaces" · turn 12 · swap_read 37]');
    expect(stubFor({ ...e })).toBe(s);
    expect(stubFor({ ...e, bytes: 800 })).toContain(" 800 B ");
  });

  it("the arrival view is the stub, the head and the outline (A8)", () => {
    const text = big(1) + "\n## Pricing\n" + "more ".repeat(500);
    const e = { id: 1, kind: "page", source: "https://example.com/p1", bytes: text.length, title: "Page 1", turn: 1 };
    const v = arrivalView(e, text, 2048);
    expect(v.startsWith(stubFor(e))).toBe(true);
    expect(v).toContain(text.slice(0, 2048));
    expect(v).toContain("## Pricing");
    expect(v.length).toBeLessThan(text.length);
  });
});

describe("eviction (A6)", () => {
  const opts = { budgetTokens: 10000, lowWater: 0.6, minBytes: 1024 };

  it("does nothing under the budget", () => {
    const m = conversation({ calls: 2 });
    expect(planEviction(m, opts)).toEqual([]);
  });

  it("over the budget: oldest results first, down to the low-water mark, never the latest call's", () => {
    const m = conversation({ calls: 6 });   // 6 x ~2.8k tokens
    const plan = planEviction(m, opts);
    const toolIdx = m.map((x, i) => (x.role === "tool" ? i : -1)).filter((i) => i >= 0);
    expect(plan).toEqual(toolIdx.slice(0, plan.length));      // a prefix of the results: the oldest
    expect(plan).not.toContain(toolIdx.at(-1));               // the latest call is not read yet
    const left = toolTokens(m) - plan.reduce((s, i) => s + Math.ceil(m[i].content.length / 4), 0);
    expect(left).toBeLessThanOrEqual(opts.budgetTokens * opts.lowWater + 400 * plan.length);
  });

  it("never touches the operator's or the agent's messages, small results, or what is swapped already", () => {
    const m = conversation({ calls: 6 });
    m[4].content = wrap("web_fetch", "short");               // a small result
    m[2] = { ...m[2], content: "[swap #5 · page · x · 1 KB · \"x\" · turn 1 · swap_read 5]", _swap: 5 };   // a bare stub
    const plan = planEviction(m, opts);
    for (const i of plan) expect(m[i].role).toBe("tool");
    expect(plan).not.toContain(4);
    expect(plan).not.toContain(2);
  });

  it("a swap_read result goes back to its entry's stub, without a new entry", () => {
    const store = createSwapStore(dir);
    const e = store.put({ turn: 1, call: 1, tool: "web_fetch", kind: "page", source: "https://example.com/p1", title: "Page 1", text: big(1) });
    const m = conversation({ calls: 6 });
    // The oldest result is a read-back of entry 1.
    m[3] = { ...m[3], content: wrap("swap_read", stubFor(e) + "\n" + big(1)), _toolName: "swap_read", _toolArgs: { id: 1 } };
    applySwap(m, store, opts);
    expect(m[3].content).toBe(stubFor(e));
    expect(m[3]._swap).toBe(1);
    expect(store.list().filter((x) => x.tool === "swap_read")).toEqual([]);
  });

  it("an arrival view shrinks to its stub once it is old, without a new entry", () => {
    const store = createSwapStore(dir);
    const e = store.put({ turn: 1, call: 1, tool: "web_fetch", kind: "page", source: "https://example.com/p1", title: "Page 1", text: big(1) });
    const m = conversation({ calls: 6 });
    m[3] = { ...m[3], content: wrap("web_fetch", arrivalView(e, big(1), 1500)), _swap: e.id };
    applySwap(m, store, opts);
    expect(m[3].content).toBe(stubFor(e));
    expect(store.list().map((x) => x.id).filter((id) => id === e.id)).toEqual([e.id]);
    expect(store.list().filter((x) => x.source === "https://example.com/p1")).toHaveLength(1);
  });

  it("applySwap moves the text to the store, leaves a stub, and is a no-op the second time", () => {
    const m = conversation({ turns: 2, calls: 4 });
    const before = m.map((x) => x.content);
    const store = createSwapStore(dir);
    const n = applySwap(m, store, opts);
    expect(n).toBeGreaterThan(0);
    const swapped = m.filter((x) => x._swap);
    expect(swapped).toHaveLength(n);
    for (const x of swapped) {
      const e = store.get(x._swap);
      expect(x.content).toBe(stubFor(e));
      expect(store.read(e.id)).toBe(before[m.indexOf(x)].replace(/^<tool_result name="web_fetch">\n/, "").replace(/\n<\/tool_result>$/, ""));
    }
    expect(swapped[0]._swap).toBe(1);
    expect(store.get(1)).toMatchObject({ turn: 1, kind: "page", source: "https://example.com/p1", title: "Page 1" });
    for (let i = 0; i < m.length; i++) if (m[i].role !== "tool") expect(m[i].content).toBe(before[i]);
    expect(applySwap(m, store, opts)).toBe(0);
  });
});
