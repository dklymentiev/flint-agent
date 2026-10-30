// web_search asks DuckDuckGo first (2026-10-01): Bing answered the scraper with
// unrelated pages for the same queries DuckDuckGo got right.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { createSystemTools } from "../../../src/tools/system.js";
import { createMockStore } from "../../helpers/mock-store.js";

const DDG_HTML = `
<a rel="nofollow" class="result__a" href="https://vitest.dev/">Vitest | Next Generation testing framework</a>
<a class="result__snippet" href="https://vitest.dev/">A Vite-native testing framework.</a>`;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("web_search engine order", () => {
  beforeEach(() => vi.stubEnv("BRAVE_API_KEY", ""));

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

  it("says why each page gave nothing, so the model does not search again blind", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const host = new URL(url).hostname;
      if (host === "html.duckduckgo.com") throw Object.assign(new Error("aborted"), { name: "TimeoutError" });
      if (host === "www.bing.com") return { ok: false, status: 429, text: async () => "" };
      return { ok: true, status: 200, text: async () => "<html>are you a robot</html>" };
    }));
    const { handlers } = createSystemTools(createMockStore());
    const out = await handlers.web_search({ query: "anything" });
    expect(out).toContain("DuckDuckGo: no answer in 10 s");
    expect(out).toContain("Bing: HTTP 429");
    expect(out).toContain("Google: a page with no results in it");
    expect(out).toContain("BRAVE_API_KEY");
  });
});

describe("web_search with BRAVE_API_KEY", () => {
  beforeEach(() => vi.stubEnv("BRAVE_API_KEY", "test-key"));

  it("asks the Brave Search API with the key and reads no search page", async () => {
    const calls = [];
    vi.stubGlobal("fetch", vi.fn(async (url, opts) => {
      calls.push({ host: new URL(url).hostname, token: opts.headers["X-Subscription-Token"] });
      return {
        ok: true, status: 200,
        json: async () => ({ web: { results: [
          { title: "Vitest &amp; friends", url: "https://vitest.dev/", description: "A <strong>Vite-native</strong> testing framework." },
        ] } }),
      };
    }));
    const { handlers } = createSystemTools(createMockStore());
    const out = await handlers.web_search({ query: "Vitest test framework" });
    expect(calls).toEqual([{ host: "api.search.brave.com", token: "test-key" }]);
    expect(out).toContain("1. Vitest & friends");
    expect(out).toContain("https://vitest.dev/");
    expect(out).toContain("A Vite-native testing framework.");
  });

  it("reports a failing API instead of falling back to the pages", async () => {
    const hosts = [];
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      hosts.push(new URL(url).hostname);
      return { ok: false, status: 401, text: async () => "invalid subscription token" };
    }));
    const { handlers } = createSystemTools(createMockStore());
    const out = await handlers.web_search({ query: "anything" });
    expect(hosts).toEqual(["api.search.brave.com"]);
    expect(out).toMatch(/^Error: Brave Search: HTTP 401 invalid subscription token/);
  });
});
