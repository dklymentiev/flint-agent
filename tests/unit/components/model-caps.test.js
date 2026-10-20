// The OpenRouter model list says what each model can do (tools, images,
// reasoning, JSON) and, for the row the marker is on, how fast it is now.

import { describe, it, expect, vi } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { capabilitiesFrom } from "../../../src/providers/models.js";
import { modelDetail, OverlayMenu } from "../../../src/components/OverlayMenu.js";

vi.mock("../../../src/logging/logger.js", () => ({
  createLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
}));
vi.mock("../../../src/free-models.js", async (orig) => ({
  ...(await orig()),
  modelSpeed: vi.fn(async (id) => ({ tps: 85.4, firstMs: 620, uptime: 99.2, provider: "DeepInfra", id })),
}));

const h = React.createElement;
const tick = (ms = 80) => new Promise((r) => setTimeout(r, ms));
const ITEMS = [
  { id: "a/tooled", ctx: "262k", price: "$0.08 / $0.45", tools: true, caps: "think json", description: "A model that calls tools." },
  { id: "b/plain", ctx: "8k", price: "$0.01 / $0.02", tools: false, caps: "", description: null },
];

describe("capabilitiesFrom", () => {
  it("reads tools, reasoning and structured output off supported_parameters", () => {
    expect(capabilitiesFrom(["tools", "tool_choice", "reasoning", "structured_outputs"]))
      .toEqual({ tools: true, reasoning: true, structured: true });
    expect(capabilitiesFrom(["temperature"])).toEqual({ tools: false, reasoning: false, structured: false });
    expect(capabilitiesFrom(undefined)).toEqual({ tools: null, reasoning: null, structured: null });
  });
});

describe("the model list", () => {
  it("shows Tools and Can columns when the provider says", () => {
    const o = { type: "model", title: "Models", items: ITEMS, index: 0, filter: "" };
    const { lastFrame } = render(h(OverlayMenu, { overlay: o, height: 14 }));
    expect(lastFrame()).toContain("Tools");
    expect(lastFrame()).toMatch(/a\/tooled.*yes.*think json/);
    expect(lastFrame()).toMatch(/b\/plain.*no/);
  });

  it("leaves the columns out when nothing is known", () => {
    const o = { type: "model", title: "Models", items: [{ id: "x", tools: null }], index: 0, filter: "" };
    expect(render(h(OverlayMenu, { overlay: o, height: 14 })).lastFrame()).not.toContain("Tools");
  });

  it("the line under the list says the speed and the description", () => {
    expect(modelDetail(ITEMS[0], { tps: 85.4, firstMs: 620, uptime: 99.2, provider: "DeepInfra" }))
      .toBe("85 tok/s, first token 0.6 s, up 99% (DeepInfra)  ·  A model that calls tools.");
    expect(modelDetail(ITEMS[0], { loading: true })).toContain("speed: asking...");
    expect(modelDetail(ITEMS[1], undefined)).toBe("");
  });
});

describe("speed of the marked row", () => {
  it("is asked once for the OpenRouter row the marker stops on", async () => {
    const { App } = await import("../../../src/components/App.js");
    const { createMockStore } = await import("../../helpers/mock-store.js");
    const { modelSpeed } = await import("../../../src/free-models.js");
    const store = createMockStore();
    const { lastFrame } = render(h(App, { store, onSubmit: vi.fn(), onAbort() {} }));
    await tick();
    store.getState().overlayDrilldown("model", "Models -- OpenRouter", ITEMS, { providerId: "openrouter" });
    await tick(500);
    expect(modelSpeed).toHaveBeenCalledWith("a/tooled");
    expect(store.getState().overlay.details["a/tooled"].tps).toBe(85.4);
    expect(lastFrame()).toContain("85 tok/s");
    await tick(400);
    expect(modelSpeed).toHaveBeenCalledTimes(1);
  });
});
