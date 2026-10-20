// The hosts added on 2026-10-19 are in the list by default: OpenAI format, a
// bearer key, a default model. Each base URL answered "key required" (401/403)
// without a key when it was added, so the address is a live API.

import { describe, it, expect } from "vitest";
import { getProvider } from "../../src/providers/registry.js";
import { getChatUrl } from "../../src/providers/adapters/openai.js";

const ADDED = {
  cerebras: "https://api.cerebras.ai/v1/chat/completions",
  mistral: "https://api.mistral.ai/v1/chat/completions",
  deepinfra: "https://api.deepinfra.com/v1/openai/chat/completions",
  fireworks: "https://api.fireworks.ai/inference/v1/chat/completions",
  huggingface: "https://router.huggingface.co/v1/chat/completions",
  sambanova: "https://api.sambanova.ai/v1/chat/completions",
  novita: "https://api.novita.ai/openai/chat/completions",
  nebius: "https://api.studio.nebius.com/v1/chat/completions",
};

describe("providers in the list by default", () => {
  for (const [id, url] of Object.entries(ADDED)) {
    it(`${id} calls its OpenAI-compatible chat endpoint with a bearer key`, () => {
      const p = getProvider(id);
      expect(p.format).toBe("openai");
      expect(p.authType).toBe("bearer");
      expect(p.keyRequired).toBe(true);
      expect(p.defaultModel).toBeTruthy();
      expect(getChatUrl(p)).toBe(url);
    });
  }
});
