// Fact extraction silently 404ed on 1.14.5: extractionModel was the OpenRouter
// id google/gemini-2.0-flash-001 (no longer listed) and was sent to every
// provider. It must follow the active provider/model, and a failure must be
// visible once in the log instead of vanishing in `catch { return [] }`.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const warn = vi.fn();
vi.mock("../../../src/logging/logger.js", () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn, error: () => {} }),
}));

const chatCompletion = vi.fn();
vi.mock("../../../src/api/client.js", () => ({ chatCompletion }));

describe("extraction model", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    vi.resetModules();
    warn.mockClear();
    chatCompletion.mockReset();
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it("is never an OpenRouter id on another provider", async () => {
    delete process.env.EXTRACTION_MODEL;
    process.env.FLINT_PROVIDER = "ollama";
    const { config } = await import("../../../src/config.js");
    expect(config.provider).toBe("ollama");
    expect(config.extractionModel).toBe(config.model);
    expect(config.extractionModel).not.toMatch(/^google\//);
  });

  it("follows a model switch at call time", async () => {
    delete process.env.EXTRACTION_MODEL;
    process.env.FLINT_PROVIDER = "groq";
    const { config } = await import("../../../src/config.js");
    config.model = "some-other-model";
    expect(config.extractionModel).toBe("some-other-model");
  });

  it("still honours EXTRACTION_MODEL", async () => {
    process.env.EXTRACTION_MODEL = "my/model";
    const { config } = await import("../../../src/config.js");
    expect(config.extractionModel).toBe("my/model");
  });

  it("sends the current extraction model, not a value frozen at import", async () => {
    delete process.env.EXTRACTION_MODEL;
    process.env.FLINT_PROVIDER = "groq";
    const { config } = await import("../../../src/config.js");
    const { extractFacts } = await import("../../../src/memory/extract-facts.js");
    config.model = "switched-model";
    chatCompletion.mockResolvedValue({ message: { content: "[]" } });
    await extractFacts([{ role: "user", content: "hello there" }]);
    expect(chatCompletion.mock.calls[0][3].model).toBe("switched-model");
  });

  it("logs a failure once at warn level and returns no facts", async () => {
    const { extractFacts } = await import("../../../src/memory/extract-facts.js");
    chatCompletion.mockRejectedValue(new Error("404 model not found"));
    const msgs = [{ role: "user", content: "hello there" }];
    expect(await extractFacts(msgs)).toEqual([]);
    expect(await extractFacts(msgs)).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0].join(" "))).toMatch(/404 model not found/);
  });
});
