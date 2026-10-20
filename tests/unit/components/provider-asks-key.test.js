// Picking a provider that has no key asks for the key at once, in the secret
// input box, and then shows that provider's models.

import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { render } from "ink-testing-library";

vi.mock("../../../src/logging/logger.js", () => ({
  createLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
}));
const keys = { saved: {} };
vi.mock("../../../src/providers/keys.js", async (orig) => ({
  ...(await orig()),
  hasKey: (id) => Boolean(keys.saved[id]),
  setKey: vi.fn(async (id, value) => { keys.saved[id] = value; }),
}));
vi.mock("../../../src/providers/models.js", async (orig) => ({
  ...(await orig()),
  fetchModels: vi.fn(async () => [{ id: "openai/gpt-oss-120b", context_length: 131072, pricing: null }]),
}));

const h = React.createElement;
const tick = (ms = 80) => new Promise((r) => setTimeout(r, ms));
const KEY = "di-test-0123456789abcdefghijklmnop";

async function setup() {
  const { App } = await import("../../../src/components/App.js");
  const { createMockStore } = await import("../../helpers/mock-store.js");
  const store = createMockStore();
  const r = render(h(App, { store, onSubmit: vi.fn(), onAbort() {} }));
  await tick();
  store.getState().openOverlay("provider", "Select Provider", [{ id: "deepinfra", name: "DeepInfra", info: "no", disabled: true }]);
  await tick();
  return { ...r, store };
}

beforeEach(() => { keys.saved = {}; });

describe("a provider without a key", () => {
  it("asks for the key, saves it, and lists the provider's models", async () => {
    const { stdin, store, lastFrame } = await setup();
    stdin.write("\r");
    await tick(150);
    expect(store.getState().secretPrompt?.label).toBe("DeepInfra API key");
    expect(store.getState().overlay).toBeNull();
    stdin.write(KEY);
    await tick();
    expect(lastFrame()).not.toContain(KEY);
    stdin.write("\r");
    await tick(300);
    const { setKey } = await import("../../../src/providers/keys.js");
    expect(setKey).toHaveBeenCalledWith("deepinfra", KEY);
    expect(store.getState().overlay?.type).toBe("model");
    expect(lastFrame()).toContain("openai/gpt-oss-120b");
  });

  it("an empty answer cancels and saves nothing", async () => {
    const { stdin, store } = await setup();
    stdin.write("\r");
    await tick(150);
    stdin.write("\x1b");
    await tick(150);
    expect(keys.saved).toEqual({});
    expect(store.getState().overlay).toBeNull();
  });
});
