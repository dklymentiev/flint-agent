// What Flint tells OpenRouter about itself.
//
// OpenRouter has no app registration: an app IS the URL sent as HTTP-Referer.
// Its page, its token counter and the link in every user's activity log hang
// off that URL, so changing it does not rename the app, it starts a new one
// at zero and orphans the old. That is why the value is pinned here and not
// left to whoever next tidies the config.
//
// The categories are held to OpenRouter's own limits because a request that
// breaks them is not rejected, the header is just ignored, and nothing in
// Flint would ever notice.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildHeaders } from "../../../src/providers/adapters/openai.js";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");
const providers = JSON.parse(readFileSync(join(ROOT, "config", "providers.json"), "utf8"));

// https://openrouter.ai/docs/app-attribution, read 2026-10-03.
const KNOWN_CATEGORIES = [
  "cli-agent", "ide-extension", "cloud-agent", "programming-app", "native-app-builder",
  "creative-writing", "video-gen", "image-gen", "audio-gen",
  "writing-assistant", "general-chat", "personal-agent", "legal",
  "roleplay", "game",
];
const MAX_CATEGORIES_PER_REQUEST = 2;

describe("OpenRouter attribution", () => {
  const sent = buildHeaders(providers.openrouter, "sk-test");

  it("identifies the app by the product site", () => {
    expect(sent["HTTP-Referer"]).toBe("https://flintagent.dev");
  });

  it("names the app with the current header, not the legacy one", () => {
    expect(sent["X-OpenRouter-Title"]).toBe("Flint Agent");
    expect(sent).not.toHaveProperty("X-Title");
  });

  it("sends categories OpenRouter will accept", () => {
    const categories = sent["X-OpenRouter-Categories"].split(",");
    expect(categories.length).toBeGreaterThan(0);
    expect(categories.length).toBeLessThanOrEqual(MAX_CATEGORIES_PER_REQUEST);
    for (const c of categories) expect(KNOWN_CATEGORIES).toContain(c);
  });

  it("keeps the attribution headers off every other provider", () => {
    for (const [name, provider] of Object.entries(providers)) {
      if (name === "openrouter") continue;
      const headers = provider.headers || {};
      expect(Object.keys(headers).filter((h) => /referer|openrouter/i.test(h)), name).toEqual([]);
    }
  });
});
