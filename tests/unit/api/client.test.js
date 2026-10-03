import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// We need to mock config and provider modules before importing client
vi.mock("../../../src/config.js", () => ({
  config: {
    apiKey: "test-key",
    model: "test-model",
    apiUrl: "https://test.api/v1/chat/completions",
    provider: "openrouter",
    maxResponseTokens: 2048,
  },
}));

vi.mock("../../../src/providers/registry.js", () => ({
  getProvider: () => ({
    id: "openrouter",
    name: "OpenRouter",
    format: "openai",
    baseUrl: "https://test.api/v1",
    authType: "bearer",
    headers: {},
    defaultModel: "test-model",
  }),
  listProviders: () => [],
}));

vi.mock("../../../src/providers/models.js", () => ({
  fetchModelInfo: async () => null,
}));

const { chatCompletion } = await import("../../../src/api/client.js");

function buildSSEStream(chunks) {
  const lines = [];
  for (const chunk of chunks) {
    lines.push(`data: ${JSON.stringify(chunk)}\n\n`);
  }
  lines.push("data: [DONE]\n\n");
  const text = lines.join("");
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + 256));
      offset += 256;
    },
  });
}

let originalFetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("cleanMessages", () => {
  it("strips _toolName, _toolArgs, _compressed from messages", async () => {
    let capturedBody;
    globalThis.fetch = vi.fn(async (url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return {
        ok: true,
        body: buildSSEStream([
          { id: "gen-1", choices: [{ delta: { content: "hi" } }], usage: { prompt_tokens: 5, completion_tokens: 2 } },
        ]),
      };
    });
    const messages = [
      { role: "tool", content: "result", _toolName: "read_file", _toolArgs: { path: "x" }, _compressed: "summary" },
    ];
    await chatCompletion(messages, [], () => {});
    const sent = capturedBody.messages[0];
    expect(sent).not.toHaveProperty("_toolName");
    expect(sent).not.toHaveProperty("_toolArgs");
    expect(sent).not.toHaveProperty("_compressed");
    expect(sent.content).toBe("result");
  });
});

describe("content arrays preserved", () => {
  it("does not modify array content", async () => {
    let capturedBody;
    globalThis.fetch = vi.fn(async (url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return {
        ok: true,
        json: async () => ({
          id: "gen-1",
          choices: [{ message: { role: "assistant", content: "ok" } }],
          usage: { prompt_tokens: 5, completion_tokens: 2 },
        }),
      };
    });
    const messages = [
      { role: "user", content: [{ type: "text", text: "hi" }, { type: "image_url", image_url: { url: "data:..." } }] },
    ];
    await chatCompletion(messages, [], () => {});
    expect(Array.isArray(capturedBody.messages[0].content)).toBe(true);
  });
});

describe("SSE parsing", () => {
  it("parses content from SSE chunks", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      body: buildSSEStream([
        { id: "gen-1", choices: [{ delta: { content: "Hello" } }] },
        { id: "gen-1", choices: [{ delta: { content: " World" } }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
      ]),
    }));
    const tokens = [];
    const result = await chatCompletion([], [], (t) => tokens.push(t));
    expect(tokens).toEqual(["Hello", " World"]);
    expect(result.message.content).toBe("Hello World");
  });

  it("handles [DONE] marker", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      body: buildSSEStream([
        { id: "gen-1", choices: [{ delta: { content: "done" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
      ]),
    }));
    const result = await chatCompletion([], []);
    expect(result.message.content).toBe("done");
  });
});

describe("tool_calls aggregation", () => {
  it("assembles tool_calls from delta chunks", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      body: buildSSEStream([
        {
          id: "gen-1",
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: "call_123",
                function: { name: "read_file", arguments: '{"pa' },
              }],
            },
          }],
        },
        {
          id: "gen-1",
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                function: { arguments: 'th":"test.txt"}' },
              }],
            },
          }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        },
      ]),
    }));
    const result = await chatCompletion([], []);
    expect(result.message.tool_calls).toHaveLength(1);
    expect(result.message.tool_calls[0].id).toBe("call_123");
    expect(result.message.tool_calls[0].function.name).toBe("read_file");
    const args = JSON.parse(result.message.tool_calls[0].function.arguments);
    expect(args.path).toBe("test.txt");
  });
});

// OpenRouter spreads one model over several hosts that bill differently and
// answer differently: on 2026-09-28 DigitalOcean billed cache reads at 27x
// Xiaomi's rate and once answered a file-sorting task about Kubernetes. A
// provider preference pins the main model's calls; a side call on another
// model (facts, classifier) must not inherit it, or "only xiaomi" would send
// gemini to a host that does not serve it.
describe("OpenRouter provider preference", () => {
  const okStream = () => ({
    ok: true,
    body: buildSSEStream([{ id: "gen-1", choices: [{ delta: { content: "ok" } }], usage: { prompt_tokens: 5, completion_tokens: 2 } }]),
  });

  it("is sent with main-model calls and not with a side model's", async () => {
    const { config } = await import("../../../src/config.js");
    config.openrouterProvider = { only: ["xiaomi", "atlas-cloud"], allow_fallbacks: false };
    const bodies = [];
    globalThis.fetch = vi.fn(async (url, opts) => { bodies.push(JSON.parse(opts.body)); return okStream(); });
    try {
      await chatCompletion([{ role: "user", content: "hi" }], [], () => {});
      await chatCompletion([{ role: "user", content: "hi" }], [], null, { model: "google/gemini-2.0-flash-001", source: "facts" });
    } finally {
      delete config.openrouterProvider;
    }
    expect(bodies[0].provider).toEqual({ only: ["xiaomi", "atlas-cloud"], allow_fallbacks: false });
    expect(bodies[1].provider).toBeUndefined();
  });
});
