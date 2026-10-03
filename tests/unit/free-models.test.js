// Free mode (docs/free-mode.md, F1-F7).
import { describe, it, expect, vi, afterEach } from "vitest";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";

vi.mock("../../src/logging/logger.js", () => ({
  createLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
}));

const fm = await import("../../src/free-models.js");
const { config } = await import("../../src/config.js");

const model = (id, { prompt = "0", completion = "0", tools = true, out = ["text"], ctx = 262144, desc = "" } = {}) => ({
  id, context_length: ctx, description: desc,
  pricing: { prompt, completion },
  supported_parameters: tools ? ["tools", "temperature"] : ["temperature"],
  architecture: { output_modalities: out },
});
const CATALOG = [
  model("nvidia/nemotron-3-super-120b-a12b:free"),
  model("stealth/space-bunny-alpha", { ctx: 1_000_000, desc: "an anonymous model" }),
  model("google/gemma-4-31b-it:free"),
  model("nvidia/nemotron-3.5-lightning:free", { ctx: 1_000_000 }),
  model("openai/gpt-x", { prompt: "0.000001", completion: "0.000002" }),       // paid
  model("liquid/no-tools:free", { tools: false }),                            // no tool calling
  model("google/lyria-3-pro-preview", { out: ["audio"] }),                    // not text
  model("openrouter/free"),                                                   // a router, not a model
];
const ep = (provider, { uptime = 99, tps = 50, first = 1000, status = 0 } = {}) => ({
  provider_name: provider, status, uptime_last_30m: uptime,
  throughput_last_30m: tps == null ? null : { p50: tps }, latency_last_30m: first == null ? null : { p50: first },
});

const saved = (name) => path.join(process.env.FLINT_DATA_DIR, name);
afterEach(() => { for (const f of ["free.json"]) if (existsSync(saved(f))) rmSync(saved(f)); config.freeChain = null; });

describe("F1 candidates", () => {
  it("zero price, tool calling, text output; by price, not by name; stealth flagged", () => {
    const ids = fm.freeCandidates(CATALOG).map((m) => m.id);
    expect(ids).toEqual(["nvidia/nemotron-3-super-120b-a12b:free", "stealth/space-bunny-alpha", "google/gemma-4-31b-it:free", "nvidia/nemotron-3.5-lightning:free"]);
    const bunny = fm.freeCandidates(CATALOG).find((m) => m.id === "stealth/space-bunny-alpha");
    expect(bunny).toMatchObject({ vendor: "stealth", context: 1_000_000, stealth: true });
    expect(fm.freeCandidates(CATALOG)[0].stealth).toBe(false);
  });
});

describe("F2 stats", () => {
  it("from the endpoint with the best uptime; missing numbers stay missing", () => {
    expect(fm.endpointStats([ep("A", { uptime: 80, tps: 90 }), ep("B", { uptime: 99.8, tps: 70, first: 1034 })]))
      .toEqual({ tps: 70, firstMs: 1034, uptime: 99.8, provider: "B" });
    expect(fm.endpointStats([ep("G", { uptime: null, tps: 17, first: null })])).toEqual({ tps: 17, firstMs: null, uptime: null, provider: "G" });
    expect(fm.endpointStats([])).toEqual({ tps: null, firstMs: null, uptime: null, provider: null });
  });
});

describe("F3 light models", () => {
  it("are told by size or name, and go after full-size ones", () => {
    const light = ["liquid/lfm-2.5-2.6b:free", "apodex/apodex-1.1-mini:free", "thinkingmachines/inkling-small:free", "inclusionai/ling-3.1-flash", "nvidia/nemotron-3.5-lightning:free", "poolside/laguna-xs-2.1:free", "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free"];
    const full = ["nvidia/nemotron-3-super-120b-a12b:free", "nvidia/nemotron-3-ultra-550b-a55b:free", "qwen/qwen3.8-27b:free", "google/gemma-4-26b-a4b-it:free", "thinkingmachines/inkling:free", "stealth/space-bunny-alpha", "dots-studio/dots-3-note-preview:free"];
    for (const id of light) expect(fm.isLight(id), id).toBe(true);
    for (const id of full) expect(fm.isLight(id), id).toBe(false);
    const ranked = fm.rankFree([
      { id: "l/lfm-2.6b:free", vendor: "l", light: true, tps: 126, uptime: 100 },
      { id: "n/super-120b:free", vendor: "n", light: false, tps: 67, uptime: 99.8 },
    ]);
    expect(ranked[0].id).toBe("n/super-120b:free");
  });
});

describe("F3 ranking and chain", () => {
  const list = [
    { id: "a/slow:free", vendor: "a", tps: 17, firstMs: 1300, uptime: null },
    { id: "b/flaky:free", vendor: "b", tps: 200, firstMs: 300, uptime: 60 },
    { id: "a/fast:free", vendor: "a", tps: 70, firstMs: 1000, uptime: 99.8 },
    { id: "c/mid:free", vendor: "c", tps: 62, firstMs: 1600, uptime: 99.9 },
  ];
  it("available (>= 90% or no data) before the rest, then speed", () => {
    expect(fm.rankFree(list).map((m) => m.id)).toEqual(["a/fast:free", "c/mid:free", "a/slow:free", "b/flaky:free"]);
  });
  it("fallbacks come from other vendors than the primary's and each other's", () => {
    expect(fm.freeChain(fm.rankFree(list))).toEqual(["a/fast:free", "c/mid:free", "b/flaky:free"]);
    expect(fm.freeChain(fm.rankFree(list), "a/slow:free")).toEqual(["a/slow:free", "c/mid:free", "b/flaky:free"]);
  });
});

describe("F4 limits and today's count", () => {
  it("50 on the free tier, 1000 otherwise", () => {
    expect(fm.dailyFreeLimit({ is_free_tier: true })).toBe(50);
    expect(fm.dailyFreeLimit({ is_free_tier: false })).toBe(1000);
    expect(fm.dailyFreeLimit(null)).toBe(50);
  });
  it("counts per day and starts again the next day", () => {
    const day1 = new Date("2026-10-02T10:00:00");
    fm.recordFreeRequest(day1);
    fm.recordFreeRequest(day1);
    expect(fm.freeUsedToday(day1)).toBe(2);
    expect(fm.freeUsedToday(new Date("2026-10-03T08:00:00"))).toBe(0);
  });
});

describe("F5 the request in free mode", () => {
  const or = { id: "openrouter" };
  it("the main model's request carries the chain as models; nothing else does", () => {
    const chain = ["a/fast:free", "c/mid:free", "b/flaky:free"];
    expect(fm.freeRequestFields({ chain, provider: or, model: "a/fast:free", mainModel: "a/fast:free" })).toEqual({ models: chain });
    expect(fm.freeRequestFields({ chain, provider: or, model: "x/side", mainModel: "a/fast:free" })).toEqual({});
    expect(fm.freeRequestFields({ chain, provider: { id: "openai" }, model: "a/fast:free", mainModel: "a/fast:free" })).toEqual({});
    expect(fm.freeRequestFields({ chain: null, provider: or, model: "a", mainModel: "a" })).toEqual({});
  });
});

describe("F6 messages", () => {
  it("one notice per change of serving model", () => {
    const n = fm.createServedModelNotifier();
    expect(n("a/fast:free", "a/fast:free")).toBeNull();
    expect(n("a/fast:free", "c/mid:free")).toBe("free: a/fast:free did not answer; c/mid:free did");
    expect(n("a/fast:free", "c/mid:free")).toBeNull();
    expect(n("a/fast:free", "a/fast:free")).toBe("free: back on a/fast:free");
  });
  it("a 402 in free mode explains the negative balance", () => {
    expect(fm.paymentRequiredMessage(true)).toMatch(/below zero.*free models too.*openrouter\.ai\/credits/i);
    expect(fm.paymentRequiredMessage(false)).toBeNull();
  });
});

describe("F7 the command", () => {
  const fetchJson = async (url) => {
    if (url.endsWith("/models")) return { data: CATALOG };
    if (url.endsWith("/key")) return { data: { is_free_tier: false } };
    const id = decodeURIComponent(url.match(/models\/(.+)\/endpoints$/)[1]);
    const stats = {
      "nvidia/nemotron-3-super-120b-a12b:free": ep("Nvidia", { uptime: 99.8, tps: 70, first: 1034 }),
      "stealth/space-bunny-alpha": ep("Stealth", { uptime: 99.9, tps: 62, first: 1645 }),
      "google/gemma-4-31b-it:free": ep("Google AI Studio", { uptime: null, tps: 17, first: 1348 }),
      "nvidia/nemotron-3.5-lightning:free": ep("Nvidia", { uptime: 50, tps: 300, first: 400 }),
    };
    return { data: { endpoints: [stats[id]] } };
  };

  it("loads the list ranked, with the daily limit", async () => {
    const r = await fm.loadFreeModels({ fetchJson });
    expect(r.limit).toBe(1000);
    expect(r.models.map((m) => m.id)).toEqual(["nvidia/nemotron-3-super-120b-a12b:free", "stealth/space-bunny-alpha", "google/gemma-4-31b-it:free", "nvidia/nemotron-3.5-lightning:free"]);
  });

  async function setup() {
    const { createMockStore } = await import("../helpers/mock-store.js");
    const { initCommands, tryHandleCommand } = await import("../../src/commands/registry.js");
    const store = createMockStore();
    initCommands(store);
    const text = () => store.getState().lines.map((l) => String(l.text).replace(/\x1b\[[0-9;]*m/g, "")).join("\n");
    return { store, run: (c) => tryHandleCommand(c, store), text };
  }

  it("/model free auto takes the best with fallbacks and saves them; /model <id> leaves free mode; /model free opens the list", async () => {
    fm.setFreeFetchJson(fetchJson);
    const { store, run, text } = await setup();
    await run("/model free auto");
    expect(config.model).toBe("nvidia/nemotron-3-super-120b-a12b:free");
    expect(config.freeChain).toEqual(["nvidia/nemotron-3-super-120b-a12b:free", "stealth/space-bunny-alpha", "google/gemma-4-31b-it:free"]);
    expect(fm.loadFreeChain()).toEqual(config.freeChain);
    expect(text()).toMatch(/free: nvidia\/nemotron-3-super-120b-a12b:free/);
    await run("/model openai/gpt-x");
    expect(config.freeChain).toBeNull();
    expect(fm.loadFreeChain()).toBeNull();
    await run("/model free");
    expect(store.getState().overlay?.type).toBe("free");
    expect(store.getState().overlay.items[0]).toMatchObject({ id: "nvidia/nemotron-3-super-120b-a12b:free", tps: 70 });
    fm.setFreeFetchJson(null);
  });
});
