// web_search asks DuckDuckGo first (2026-10-01): Bing answered the scraper with
// unrelated pages for the same queries DuckDuckGo got right.
import { describe, it, expect, vi, afterEach } from "vitest";
import { createSystemTools } from "../../../src/tools/system.js";
import { createMockStore } from "../../helpers/mock-store.js";

const DDG_HTML = `
<a rel="nofollow" class="result__a" href="https://vitest.dev/">Vitest | Next Generation testing framework</a>
<a class="result__snippet" href="https://vitest.dev/">A Vite-native testing framework.</a>`;

afterEach(() => vi.unstubAllGlobals());

describe("web_search engine order", () => {
  it("asks DuckDuckGo first and does not touch Bing when it answers", async () => {
    const asked = [];
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      asked.push(new URL(url).hostname);
      return { ok: true, status: 200, text: async () => (String(url).includes("duckduckgo") ? DDG_HTML : "") };
    }));
    const { handlers } = createSystemTools(createMockStore());
    const out = await handlers.web_search({ query: "Vitest test framework" });
    expect(asked[0]).toBe("html.duckduckgo.com");
    expect(asked).not.toContain("www.bing.com");
    expect(out).toContain("Vitest | Next Generation testing framework");
  });

  it("falls back to Bing when DuckDuckGo returns nothing", async () => {
    const asked = [];
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      asked.push(new URL(url).hostname);
      return { ok: true, status: 200, text: async () => "" };
    }));
    const { handlers } = createSystemTools(createMockStore());
    await handlers.web_search({ query: "anything" });
    expect(asked.slice(0, 2)).toEqual(["html.duckduckgo.com", "www.bing.com"]);
  });
});
