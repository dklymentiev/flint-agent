// NVIDIA's hosted API (build.nvidia.com) is a provider like Groq: OpenAI
// format, a bearer key set with /key nvidia, the model list from its /models.

import { describe, it, expect } from "vitest";
import { getProvider } from "../../src/providers/registry.js";
import { getChatUrl, buildHeaders } from "../../src/providers/adapters/openai.js";

describe("nvidia provider", () => {
  const p = getProvider("nvidia");

  it("calls NVIDIA's OpenAI-compatible chat endpoint", () => {
    expect(getChatUrl(p)).toBe("https://integrate.api.nvidia.com/v1/chat/completions");
  });

  it("sends the key as a bearer token", () => {
    expect(buildHeaders(p, "nvapi-test").Authorization).toBe("Bearer nvapi-test");
  });

  it("needs a key and has a default model", () => {
    expect(p.keyRequired).toBe(true);
    expect(p.defaultModel).toBeTruthy();
  });
});
