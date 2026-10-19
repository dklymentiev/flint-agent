// Every streamed request asks for its usage: without stream_options OpenAI,
// NVIDIA and others end the stream with no usage chunk, and the turn costs
// nothing as far as the cost guard knows.

import { describe, it, expect } from "vitest";
import { buildBody, parseStreamResponse } from "../../src/providers/adapters/openai.js";

describe("stream usage", () => {
  it("a streamed request asks for the usage", () => {
    expect(buildBody([], "m", null, 16, true).stream_options).toEqual({ include_usage: true });
  });

  it("a whole request does not carry stream options", () => {
    expect(buildBody([], "m", null, 16, false).stream_options).toBeUndefined();
  });

  it("the usage-only chunk that ends such a stream is read", async () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"ok"}}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
      'data: {"choices":[],"usage":{"prompt_tokens":18,"completion_tokens":2}}',
      "data: [DONE]",
      "",
    ].join("\n\n");
    const { message, usage } = await parseStreamResponse(new Response(sse), () => {});
    expect(message.content).toBe("ok");
    expect(usage).toEqual({ prompt_tokens: 18, completion_tokens: 2 });
  });
});
