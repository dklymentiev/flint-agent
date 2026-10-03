// A stray keypress must not be saved as an API key (owner, 2026-10-01: a "1"
// typed at a prompt hidden by the spinner was stored as the OpenRouter key).
import { describe, it, expect } from "vitest";
import { looksLikeApiKey } from "../../src/cli.js";

describe("looksLikeApiKey", () => {
  it("rejects a stray keypress", () => {
    expect(looksLikeApiKey("1")).toBe(false);
    expect(looksLikeApiKey("")).toBe(false);
  });
  it("rejects text with spaces", () => {
    expect(looksLikeApiKey("this is not a key but it is long")).toBe(false);
  });
  it("accepts a real-looking key", () => {
    expect(looksLikeApiKey("sk-or-v1-" + "a".repeat(40))).toBe(true);
  });
});
