import { describe, it, expect, beforeEach, vi } from "vitest";
import { createSystemTools, parseGoogleHTML, parseDDGHTML } from "../../../src/tools/system.js";
import { createMockStore } from "../../helpers/mock-store.js";

let store;
let handlers;

beforeEach(() => {
  store = createMockStore();
  const sys = createSystemTools(store);
  handlers = sys.handlers;
});

describe("peek_process", () => {
  it("returns last N lines for existing process", async () => {
    const id = store.getState().addProcess({ cmd: "echo test", pid: 123 });
    store.getState().appendProcessOutput(id, "line1");
    store.getState().appendProcessOutput(id, "line2");
    store.getState().appendProcessOutput(id, "line3");
    const result = await handlers.peek_process({ process_id: id, lines: 2 });
    expect(result).toContain("line2");
    expect(result).toContain("line3");
  });

  it("returns error for non-existent process", async () => {
    const result = await handlers.peek_process({ process_id: 999 });
    expect(result).toContain("not found");
  });

  it("returns (no output yet) for empty output", async () => {
    const id = store.getState().addProcess({ cmd: "sleep 10", pid: 456 });
    const result = await handlers.peek_process({ process_id: id });
    expect(result).toContain("no output yet");
  });

  it("clamps lines to max 50", async () => {
    const id = store.getState().addProcess({ cmd: "test", pid: 789 });
    for (let i = 0; i < 60; i++) {
      store.getState().appendProcessOutput(id, `line${i}`);
    }
    // lines=100 should be clamped to 50
    const result = await handlers.peek_process({ process_id: id, lines: 100 });
    // Process output buffer is max 50, and lines clamped to 50
    expect(result).toContain("50 lines");
  });
});

describe("list_processes", () => {
  it("returns message when no processes", async () => {
    const result = await handlers.list_processes();
    expect(result).toContain("No background processes");
  });

  it("returns formatted table with processes", async () => {
    store.getState().addProcess({ cmd: "npm test", pid: 100 });
    store.getState().addProcess({ cmd: "node server.js", pid: 200 });
    const result = await handlers.list_processes();
    expect(result).toContain("npm test");
    expect(result).toContain("node server.js");
    expect(result).toContain("ID");
    expect(result).toContain("Status");
  });
});

describe("kill_process", () => {
  it("returns error for non-existent process", async () => {
    const result = await handlers.kill_process({ process_id: 999 });
    expect(result).toContain("not found");
  });
});

describe("think", () => {
  it("returns acknowledgement", async () => {
    const result = await handlers.think({ thought: "Let me analyze this..." });
    expect(result).toContain("recorded");
  });
});

// Helper: create a mock ReadableStream body from a string
function mockBody(text) {
  const encoded = new TextEncoder().encode(text);
  return {
    getReader() {
      let done = false;
      return {
        async read() {
          if (done) return { done: true, value: undefined };
          done = true;
          return { done: false, value: encoded };
        },
        cancel() {},
      };
    },
  };
}

describe("web_fetch", () => {
  it("handles successful response", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      body: mockBody("Hello from server"),
      headers: new Headers({ "content-type": "text/plain" }),
    }));
    try {
      const result = await handlers.web_fetch({ url: "http://example.com" });
      expect(result).toContain("HTTP 200");
      expect(result).toContain("Hello from server");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("handles HTTP error", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 404,
      statusText: "Not Found",
    }));
    try {
      const result = await handlers.web_fetch({ url: "http://example.com/nope" });
      expect(result).toContain("Error");
      expect(result).toContain("404");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("truncates long responses", async () => {
    const originalFetch = globalThis.fetch;
    const longText = "x".repeat(10000);
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      body: mockBody(longText),
      headers: new Headers({ "content-type": "text/plain" }),
    }));
    try {
      const result = await handlers.web_fetch({ url: "http://example.com", max_length: 100 });
      // Was toContain("truncated"), which went red when e7bfb9b reworded the
      // header to "(TRUNCATED)". Nothing was broken and nobody updated the
      // test, so it sat red for months and got waved off as "known". Assert
      // the contract rather than a word: the header states the true total and
      // says it cut, and the body really is max_length characters.
      const [header, ...rest] = result.split("\n\n");
      expect(header).toMatch(/TRUNCATED/i);
      expect(header).toContain("10000 chars TOTAL");
      expect(header).toContain("returning first 100");
      expect(rest.join("\n\n")).toHaveLength(100);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rejects responses over 2 MB by content-length", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      body: mockBody("x"),
      headers: new Headers({ "content-type": "application/octet-stream", "content-length": "5000000" }),
    }));
    try {
      const result = await handlers.web_fetch({ url: "http://example.com/big" });
      expect(result).toContain("Large response");
      expect(result).toContain("curl/wget");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("web_search", () => {
  it("returns formatted results on success", async () => {
    const originalFetch = globalThis.fetch;
    // Mock Google returning results HTML
    const googleHTML = `
      <div class="g"><a href="/url?q=https%3A%2F%2Fexample.com%2Fpage1&amp;sa=U"><h3>Example Page 1</h3></a></div>
      <div class="g"><a href="/url?q=https%3A%2F%2Fexample.com%2Fpage2&amp;sa=U"><h3>Example Page 2</h3></a></div>
    `;
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      text: async () => googleHTML,
    }));
    try {
      const result = await handlers.web_search({ query: "test query" });
      expect(result).toContain("Example Page 1");
      expect(result).toContain("example.com/page1");
      expect(result).toContain("Example Page 2");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("answers from DuckDuckGo first, without asking Google or Bing", async () => {
    const originalFetch = globalThis.fetch;
    let callCount = 0;
    globalThis.fetch = vi.fn(async (url) => {
      callCount++;
      if (url.includes("google.com")) {
        return { ok: false, status: 429 };
      }
      // DDG response
      return {
        ok: true,
        text: async () => `
          <a class="result__a" href="https://ddg-result.com">DDG Result</a>
          <a class="result__snippet" href="#">A snippet here</a>
        `,
      };
    });
    try {
      const result = await handlers.web_search({ query: "test" });
      expect(result).toContain("DDG Result");
      expect(callCount).toBe(1); // DuckDuckGo first since 2026-10-01
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns 'no results' when both fail", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 500 }));
    try {
      const result = await handlers.web_search({ query: "nothing" });
      expect(result).toContain("No results");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("parseGoogleHTML", () => {
  it("extracts title and URL from Google HTML", () => {
    const html = `
      <a href="/url?q=https%3A%2F%2Fexample.com%2Ffoo&amp;sa=U"><h3 class="LC20lb">Test Title</h3></a>
      <a href="/url?q=https%3A%2F%2Fother.org%2Fbar&amp;sa=U"><h3>Other Title</h3></a>
    `;
    const results = parseGoogleHTML(html, 5);
    expect(results).toHaveLength(2);
    expect(results[0].title).toBe("Test Title");
    expect(results[0].url).toBe("https://example.com/foo");
    expect(results[1].title).toBe("Other Title");
    expect(results[1].url).toBe("https://other.org/bar");
  });

  it("respects max limit", () => {
    const html = `
      <a href="/url?q=https%3A%2F%2Fa.com&sa=U"><h3>A</h3></a>
      <a href="/url?q=https%3A%2F%2Fb.com&sa=U"><h3>B</h3></a>
      <a href="/url?q=https%3A%2F%2Fc.com&sa=U"><h3>C</h3></a>
    `;
    const results = parseGoogleHTML(html, 2);
    expect(results).toHaveLength(2);
  });

  it("decodes HTML entities", () => {
    const html = `<a href="/url?q=https%3A%2F%2Ftest.com&sa=U"><h3>Tom &amp; Jerry&#39;s</h3></a>`;
    const results = parseGoogleHTML(html, 5);
    expect(results[0].title).toBe("Tom & Jerry's");
  });

  it("returns empty for no results", () => {
    expect(parseGoogleHTML("<html><body>no results</body></html>", 5)).toEqual([]);
  });
});

describe("parseDDGHTML", () => {
  it("extracts results from DuckDuckGo HTML", () => {
    const html = `
      <a class="result__a" href="https://example.com">Example Title</a>
      <a class="result__snippet" href="#">This is a snippet for the result</a>
      <a class="result__a" href="https://other.org">Other Title</a>
      <a class="result__snippet" href="#">Another snippet text here</a>
    `;
    const results = parseDDGHTML(html, 5);
    expect(results).toHaveLength(2);
    expect(results[0].title).toBe("Example Title");
    expect(results[0].url).toBe("https://example.com");
    expect(results[0].snippet).toContain("snippet for the result");
    expect(results[1].title).toBe("Other Title");
  });

  it("handles uddg redirect URLs", () => {
    const html = `<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Freal.com%2Fpage&amp;rut=abc">Title</a>`;
    const results = parseDDGHTML(html, 5);
    expect(results[0].url).toBe("https://real.com/page");
  });

  it("returns empty for no results", () => {
    expect(parseDDGHTML("<html>nothing</html>", 5)).toEqual([]);
  });
});
