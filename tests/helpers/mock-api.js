import { vi } from "vitest";

/**
 * Build SSE text from a list of response objects.
 * Each response: { content?: string, tool_calls?: [...] }
 */
function buildSSE(responses) {
  const chunks = [];
  for (const resp of responses) {
    const delta = {};
    if (resp.content) delta.content = resp.content;
    if (resp.tool_calls) delta.tool_calls = resp.tool_calls;
    chunks.push(
      `data: ${JSON.stringify({
        id: "gen-test-123",
        choices: [{ delta }],
        usage: resp.usage || { prompt_tokens: 10, completion_tokens: 5 },
      })}\n\n`
    );
  }
  chunks.push("data: [DONE]\n\n");
  return chunks.join("");
}

/**
 * Create a readable stream from SSE text for mocking fetch response.body
 */
function sseToReadableStream(sseText) {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(sseText);
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      // Send in chunks of ~128 bytes to simulate streaming
      const chunk = bytes.slice(offset, offset + 128);
      offset += 128;
      controller.enqueue(chunk);
    },
  });
}

/**
 * Mock global fetch to return scripted SSE responses for chatCompletion.
 *
 * @param {Array<Array<object>>} responseSequence - Array of response arrays, one per API call.
 *   Each inner array contains SSE delta objects: { content?, tool_calls?, usage? }
 *
 * Example:
 *   mockChatCompletion([
 *     [{ content: "Hello!" }],                        // 1st API call
 *     [{ tool_calls: [...] }],                        // 2nd API call
 *     [{ content: "Done" }],                          // 3rd API call
 *   ])
 */
export function mockChatCompletion(responseSequence) {
  let callIndex = 0;
  const mockFetch = vi.fn(async (url, opts) => {
    const responses = responseSequence[callIndex] || [{ content: "fallback" }];
    callIndex++;
    const sseText = buildSSE(responses);
    return {
      ok: true,
      status: 200,
      body: sseToReadableStream(sseText),
      headers: new Headers({ "content-type": "text/event-stream" }),
      text: async () => sseText,
    };
  });
  return mockFetch;
}
