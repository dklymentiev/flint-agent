// swap_list and swap_read (docs/context-swap.md, A9).
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSwapStore } from "../../../src/agent/swap.js";
import { swapToolDefs, createSwapHandlers } from "../../../src/tools/swap-tools.js";

let store;
let handlers;
beforeEach(() => {
  store = createSwapStore(mkdtempSync(path.join(tmpdir(), "flint-swap-")));
  handlers = createSwapHandlers(() => store);
  store.put({ turn: 1, call: 1, tool: "web_fetch", kind: "page", source: "https://help.example.com/dots", title: "Getting started with dots", text: "# Getting started\nline 2\nline 3\nline 4" });
  store.put({ turn: 2, call: 1, tool: "web_fetch", kind: "page", source: "https://news.example.org/muse", title: "Muse backdoor setting", text: "# Muse\nsecond" });
});

describe("swap tools", () => {
  it("are defined for the model", () => {
    expect(swapToolDefs.map((t) => t.function.name)).toEqual(["swap_list", "swap_read"]);
  });

  it("swap_list shows one stub line per entry, newest first, filtered", async () => {
    const all = await handlers.swap_list({});
    expect(all.split("\n").filter((l) => l.startsWith("[swap #")).map((l) => l.match(/#(\d+)/)[1])).toEqual(["2", "1"]);
    const muse = await handlers.swap_list({ text: "muse" });
    expect(muse).toContain("#2");
    expect(muse).not.toContain("#1 ");
    expect(await handlers.swap_list({ turn: 1 })).toContain("help.example.com/dots");
    expect(await handlers.swap_list({ source: "nothing-like-this" })).toMatch(/nothing/i);
  });

  it("swap_read gives the stub then the text, or a range of lines", async () => {
    const whole = await handlers.swap_read({ id: 1 });
    expect(whole.split("\n")[0]).toMatch(/^\[swap #1 /);
    expect(whole).toContain("line 4");
    const part = await handlers.swap_read({ id: 1, offset: 2, limit: 2 });
    expect(part).toContain("line 2\nline 3");
    expect(part).not.toContain("line 4");
  });

  it("an unknown id says so", async () => {
    expect(await handlers.swap_read({ id: 77 })).toMatch(/no swap entry #77/i);
  });

  it("without a session store, says swap is not available", async () => {
    const none = createSwapHandlers(() => null);
    expect(await none.swap_list({})).toMatch(/not available/i);
  });
});
