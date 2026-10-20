// Typing in an open /model or /provider list narrows it, and Enter takes the
// row the marker is on, sorted or filtered.

import { describe, it, expect, vi } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { overlayItems, matchesFilter } from "../../../src/components/OverlayMenu.js";

vi.mock("../../../src/logging/logger.js", () => ({
  createLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
}));

const h = React.createElement;
const tick = (ms = 80) => new Promise((r) => setTimeout(r, ms));
const MODELS = [
  { id: "z-ai/glm-5.3", _priceNum: 3, _ctxNum: 100 },
  { id: "nvidia/nemotron-3-super-120b-a12b", _priceNum: 1, _ctxNum: 300 },
  { id: "openai/gpt-oss-20b", _priceNum: 2, _ctxNum: 200 },
  { id: "z-ai/glm-5.3-flash", _priceNum: 0.5, _ctxNum: 50 },
];

describe("overlayItems", () => {
  it("every word of the filter must match, case ignored", () => {
    expect(matchesFilter({ id: "z-ai/glm-5.3" }, "GLM 5")).toBe(true);
    expect(matchesFilter({ id: "z-ai/glm-5.3" }, "glm flash")).toBe(false);
    expect(matchesFilter({ id: "x", name: "NVIDIA" }, "nvid")).toBe(true);
  });

  it("filters the sorted list", () => {
    const o = { type: "model", items: MODELS, sortMode: "price", filter: "glm" };
    expect(overlayItems(o).map((m) => m.id)).toEqual(["z-ai/glm-5.3-flash", "z-ai/glm-5.3"]);
  });

  it("an empty filter leaves the list as it was", () => {
    expect(overlayItems({ type: "provider", items: MODELS, filter: "" })).toBe(MODELS);
  });
});

async function setup() {
  const { App } = await import("../../../src/components/App.js");
  const { createMockStore } = await import("../../helpers/mock-store.js");
  const store = createMockStore();
  const r = render(h(App, { store, onSubmit: vi.fn(), onAbort() {} }));
  await tick();
  store.getState().openOverlay("model", "Select Model", MODELS);
  await tick();
  return { ...r, store };
}

describe("typing in an open list", () => {
  it("narrows it, Backspace widens it, Esc clears the search before closing", async () => {
    const { stdin, store, lastFrame } = await setup();
    stdin.write("gpt");
    await tick();
    expect(store.getState().overlay.filter).toBe("gpt");
    expect(lastFrame()).toContain("openai/gpt-oss-20b");
    expect(lastFrame()).not.toContain("nemotron");
    expect(lastFrame()).toContain("search: gpt");
    stdin.write("\x7f");
    await tick();
    expect(store.getState().overlay.filter).toBe("gp");
    stdin.write("\x1b");
    await tick();
    expect(store.getState().overlay).not.toBeNull();
    expect(store.getState().overlay.filter).toBe("");
    stdin.write("\x1b");
    await tick();
    expect(store.getState().overlay).toBeNull();
  });

  it("Down moves within the filtered rows only", async () => {
    const { stdin, store } = await setup();
    stdin.write("glm");
    await tick();
    for (let i = 0; i < 5; i++) { stdin.write("\x1b[B"); await tick(20); }
    expect(store.getState().overlay.index).toBe(1);
  });

  it("says when nothing matches", async () => {
    const { stdin, lastFrame } = await setup();
    stdin.write("zzz");
    await tick();
    expect(lastFrame()).toContain('Nothing matches "zzz"');
  });
});
