// Spend modes (docs/spend-modes.md, S1-S4, S6).
import { describe, it, expect, vi, afterEach } from "vitest";
import { rmSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

vi.mock("../../src/logging/logger.js", () => ({
  createLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
}));

const { getSpendLevel, setSpendLevel, parseSpendName, spendSettings } = await import("../../src/spend.js");
const { compressThresholdFor } = await import("../../src/agent/compression.js");
const { mcpInlineMax } = await import("../../src/agent/intent.js");
const { swapSettings, swapFromTokens, convSettings } = await import("../../src/agent/swap.js");
const { statusText } = await import("../../src/components/LiveZone.js");

const saved = () => path.join(os.homedir(), ".flint", "spend.json");
afterEach(() => { if (existsSync(saved())) rmSync(saved()); delete process.env.FLINT_SPEND; });

describe("choosing a level", () => {
  it("is normal by default; takes loose names; FLINT_SPEND wins over the saved one (S3)", () => {
    expect(getSpendLevel({})).toBe("normal");
    expect(parseSpendName("E")).toBe("economy");
    expect(parseSpendName("Generous")).toBe("generous");
    expect(parseSpendName("lavish")).toBeNull();
    expect(setSpendLevel("generous")).toBe("generous");
    expect(getSpendLevel({})).toBe("generous");
    expect(getSpendLevel({ FLINT_SPEND: "economy" })).toBe("economy");
    expect(getSpendLevel({ FLINT_SPEND: "nonsense" })).toBe("generous");
    expect(setSpendLevel("nonsense")).toBeNull();
  });
});

describe("what each level sets (S1, S2)", () => {
  const M = 1_000_000;
  it("normal gives today's values exactly", () => {
    expect(mcpInlineMax({}, "normal")).toBe(30);
    expect(compressThresholdFor(M, "normal")).toBe(128000);
    expect(compressThresholdFor(200_000, "normal")).toBe(100000);
    expect(compressThresholdFor(null, "normal")).toBe(64000);
    expect(swapSettings({}, "normal")).toEqual({ resultMax: 64000, budgetTokens: 16000, lowWater: 0.6, minBytes: 1024, headBytes: 1500 });
    expect(swapFromTokens({ env: {}, compressThreshold: 128000, level: "normal" })).toBe(96000);
    expect(convSettings({ env: {}, window: M, level: "normal" })).toEqual({ high: 128000, chunk: 42666, keepTurns: 4 });
  });

  // The conversation's swap used to start at 300k while compression started
  // at 128k. In between, the context was over the compression threshold on
  // the weight of the conversation alone, and compression cut tool results
  // that swap had room for. The two start together now, at every level and
  // for every window.
  it("the conversation's swap starts where the compression threshold is", () => {
    for (const level of ["economy", "normal", "generous"]) {
      for (const window of [M, 200_000, 32_000, null]) {
        expect(convSettings({ env: {}, window, level }).high, `${level}, window ${window}`).toBe(compressThresholdFor(window, level));
      }
    }
  });

  it("economy: tools through search early, compression and swap early", () => {
    expect(mcpInlineMax({}, "economy")).toBe(10);
    expect(compressThresholdFor(M, "economy")).toBe(64000);
    expect(compressThresholdFor(200_000, "economy")).toBe(50000);
    expect(compressThresholdFor(null, "economy")).toBe(32000);
    expect(swapSettings({}, "economy")).toMatchObject({ resultMax: 32000, budgetTokens: 8000, headBytes: 1024 });
    expect(swapFromTokens({ env: {}, compressThreshold: 64000, level: "economy" })).toBe(32000);
    expect(spendSettings("economy").advice).toBe(true);
  });

  it("generous: everything whole until near the window's edge", () => {
    expect(mcpInlineMax({}, "generous")).toBe(200);
    expect(compressThresholdFor(M, "generous")).toBe(800000);
    expect(compressThresholdFor(null, "generous")).toBe(200000);
    expect(swapSettings({}, "generous")).toMatchObject({ resultMax: 256000, budgetTokens: 64000, headBytes: 4096 });
    expect(swapFromTokens({ env: {}, compressThreshold: 800000, level: "generous" })).toBe(720000);
    expect(spendSettings("generous").advice).toBe(false);
  });

  it("a single-setting variable wins over the level (S3)", () => {
    expect(mcpInlineMax({ FLINT_MCP_INLINE_MAX: "5" }, "generous")).toBe(5);
    expect(swapSettings({ FLINT_SWAP_BUDGET: "1234" }, "economy").budgetTokens).toBe(1234);
    expect(swapFromTokens({ env: { FLINT_SWAP_FROM: "777" }, compressThreshold: 64000, level: "economy" })).toBe(777);
  });
});

describe("the command and the footer (S4, S6)", () => {
  async function setup() {
    const { createMockStore } = await import("../helpers/mock-store.js");
    const { initCommands, tryHandleCommand } = await import("../../src/commands/registry.js");
    const store = createMockStore();
    initCommands(store);
    const text = () => store.getState().lines.map((l) => String(l.text).replace(/\x1b\[[0-9;]*m/g, "")).join("\n");
    return { store, run: (c) => tryHandleCommand(c, store), text };
  }

  it("/spend shows the levels with the current one marked; /spend <level> saves it", async () => {
    const { store, run, text } = await setup();
    await run("/spend");
    expect(text()).toMatch(/> normal/);
    expect(text()).toContain("economy");
    await run("/spend generous");
    expect(getSpendLevel({})).toBe("generous");
    expect(store.getState()._spendLevel).toBe("generous");
    await run("/spend lavish");
    expect(text()).toMatch(/Unknown level: lavish/);
    expect(getSpendLevel({})).toBe("generous");
  });

  it("the footer shows the level next to the care level", () => {
    expect(statusText({ model: "m", spendLevel: "economy" })).toContain("spend: economy");
    expect(statusText({ model: "m" })).not.toContain("spend:");
  });
});
