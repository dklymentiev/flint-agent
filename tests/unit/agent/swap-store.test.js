// Context swap: the store on disk (docs/context-swap.md, A2, A5).
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSwapStore } from "../../../src/agent/swap.js";

let dir;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "flint-swap-")); });

const page = (n, extra = "") => `# Page ${n}\n\n${"body text ".repeat(50)}${extra}`;
const rec = (n, over = {}) => ({
  turn: 3, call: n, tool: "mcp_browser_page_read", kind: "page",
  source: `https://example.com/p${n}`, title: `Page ${n}`, text: page(n), ...over,
});

describe("swap store", () => {
  it("writes the text under the turn's folder and one index line per entry", () => {
    const store = createSwapStore(dir);
    const e = store.put(rec(1));
    expect(e).toMatchObject({ id: 1, turn: 3, call: 1, kind: "page", source: "https://example.com/p1", title: "Page 1" });
    expect(e.bytes).toBe(Buffer.byteLength(page(1), "utf8"));
    expect(e.file).toMatch(/^t003\/001-page-[a-z0-9-]+\.md$/);
    expect(readFileSync(path.join(dir, e.file), "utf8")).toBe(page(1));
    const index = readFileSync(path.join(dir, "index.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(index).toEqual([e]);
    expect(store.put(rec(2, { kind: "command", source: "npm test" })).file).toMatch(/^t003\/002-command-[a-z0-9-]+\.txt$/);
  });

  it("reads an entry back byte for byte, or a range of its lines", () => {
    const store = createSwapStore(dir);
    const text = "line 1\nline 2\nline 3\nline 4\nline 5";
    const e = store.put(rec(1, { text }));
    expect(store.read(e.id)).toBe(text);
    expect(store.read(e.id, { offset: 2, limit: 2 })).toBe("line 2\nline 3");
    expect(store.get(e.id)).toEqual(e);
    expect(store.get(99)).toBeNull();
    expect(store.read(99)).toBeNull();
  });

  it("lists newest first, filtered by turn, source, title words and time", () => {
    const store = createSwapStore(dir);
    store.put(rec(1, { turn: 1, title: "Manage dots in workspaces" }));
    store.put(rec(2, { turn: 2, source: "https://news.example.org/muse" }));
    store.put(rec(3, { turn: 2 }));
    expect(store.list().map((e) => e.id)).toEqual([3, 2, 1]);
    expect(store.list({ turn: 2 }).map((e) => e.id)).toEqual([3, 2]);
    expect(store.list({ source: "news.example" }).map((e) => e.id)).toEqual([2]);
    expect(store.list({ text: "DOTS" }).map((e) => e.id)).toEqual([1]);
    expect(store.list({ limit: 1 }).map((e) => e.id)).toEqual([3]);
    const later = Date.now() + 2 * 3600 * 1000;
    expect(store.list({ since: "1h", now: later })).toEqual([]);
    expect(store.list({ since: "3h", now: later })).toHaveLength(3);
  });

  it("opened again on the same folder, keeps the entries and continues the ids (A5)", () => {
    const first = createSwapStore(dir);
    first.put(rec(1));
    first.put(rec(2));
    const again = createSwapStore(dir);
    expect(again.list().map((e) => e.id)).toEqual([2, 1]);
    expect(again.read(1)).toBe(page(1));
    expect(again.put(rec(3)).id).toBe(3);
  });

  it("writes nothing until something is put", () => {
    createSwapStore(dir + "-unused");
    expect(existsSync(dir + "-unused")).toBe(false);
  });
});
