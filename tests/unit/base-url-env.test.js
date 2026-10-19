// FLINT_BASE_URL moves the provider in use to another address with the same
// API (a gateway that holds the real key), and the OpenRouter calls outside
// the chat (models, prices, the free list) follow it.

import { describe, it, expect, afterEach, vi } from "vitest";
import { applyBaseUrl } from "../../src/providers/registry.js";

const providers = () => ({
  openrouter: { id: "openrouter", baseUrl: "https://openrouter.ai/api/v1" },
  openai: { id: "openai", baseUrl: "https://api.openai.com/v1" },
});

describe("applyBaseUrl", () => {
  it("leaves every provider alone when FLINT_BASE_URL is unset", () => {
    expect(applyBaseUrl(providers(), {})).toEqual(providers());
  });

  it("moves OpenRouter when no provider is named", () => {
    const p = applyBaseUrl(providers(), { FLINT_BASE_URL: "http://192.0.2.1:8000/openai/v1/" });
    expect(p.openrouter.baseUrl).toBe("http://192.0.2.1:8000/openai/v1");
    expect(p.openai.baseUrl).toBe("https://api.openai.com/v1");
  });

  it("moves only the provider FLINT_PROVIDER names", () => {
    const p = applyBaseUrl(providers(), { FLINT_BASE_URL: "http://192.0.2.1/v1", FLINT_PROVIDER: "openai" });
    expect(p.openai.baseUrl).toBe("http://192.0.2.1/v1");
    expect(p.openrouter.baseUrl).toBe("https://openrouter.ai/api/v1");
  });

  it("ignores a provider it does not know", () => {
    expect(applyBaseUrl(providers(), { FLINT_BASE_URL: "http://192.0.2.1/v1", FLINT_PROVIDER: "nope" }))
      .toEqual(providers());
  });
});

describe("the free list follows the address", () => {
  afterEach(() => {
    delete process.env.FLINT_BASE_URL;
    vi.resetModules();
  });

  it("asks the moved OpenRouter, not openrouter.ai", async () => {
    process.env.FLINT_BASE_URL = "http://192.0.2.1:8000/openai/v1";
    vi.resetModules();
    const fm = await import("../../src/free-models.js");
    const asked = [];
    await fm.loadFreeModels({ fetchJson: async (url) => { asked.push(url); return { data: [] }; } });
    expect(asked.length).toBeGreaterThan(0);
    for (const url of asked) expect(url.startsWith("http://192.0.2.1:8000/openai/v1/")).toBe(true);
  });
});
