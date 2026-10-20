// /model with no argument says what is in use and opens the provider's model
// list, the marker on the current model.

import { describe, it, expect, vi } from "vitest";

vi.mock("../../../src/logging/logger.js", () => ({
  createLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
}));
vi.mock("../../../src/providers/models.js", async (orig) => ({
  ...(await orig()),
  fetchModels: vi.fn(async () => [
    { id: "b/second", context_length: 8000, pricing: null },
    { id: "a/first", context_length: 8000, pricing: null },
    { id: "c/third", context_length: 8000, pricing: null },
  ]),
}));

describe("/model", () => {
  it("opens the current provider's list with the marker on the model in use", async () => {
    const { config } = await import("../../../src/config.js");
    const { createMockStore } = await import("../../helpers/mock-store.js");
    const { openModelList } = await import("../../../src/ui/model-list.js");
    const store = createMockStore();
    config.provider = "openrouter";
    config.model = "b/second";
    store.getState().openOverlay("model", "Models", []);
    expect(await openModelList(store, "openrouter")).toBe(true);
    const o = store.getState().overlay;
    expect(o.type).toBe("model");
    expect(o.items.map((m) => m.id)).toEqual(["a/first", "b/second", "c/third"]);
    expect(o.index).toBe(1);
    expect(o.items[1].current).toBe(true);
    expect(o.parent.providerId).toBe("openrouter");
  });
});
