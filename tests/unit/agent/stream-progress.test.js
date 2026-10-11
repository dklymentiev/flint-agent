// What a stream carries besides text (owner, 2026-10-10).
//
// Two Flints were asked to write an 1800-word article to a file. Measured the
// same day on the same request: xiaomi/mimo-v2.6-flash sent 1069 tool-call
// argument chunks over 42 seconds and not one character of text;
// google/gemini-3.1-pro-preview sent reasoning chunks for 58 seconds and
// nothing else. The stall watchdog counted only text, so it dropped both as
// "the provider sent no answer for 90s" whenever the file took longer than
// that, three times, and stopped the turn. A model that is reasoning or
// writing a tool call is answering.
import { describe, it, expect } from "vitest";
import * as openai from "../../../src/providers/adapters/openai.js";
import * as anthropic from "../../../src/providers/adapters/anthropic.js";

function sse(lines) {
  const body = new ReadableStream({
    start(c) {
      for (const l of lines) c.enqueue(new TextEncoder().encode(l + "\n\n"));
      c.close();
    },
  });
  return { body };
}
const data = (o) => `data: ${JSON.stringify(o)}`;
const delta = (d) => data({ id: "g1", model: "m", choices: [{ delta: d }] });

describe("OpenAI-compatible stream", () => {
  it("reports tool-call arguments as progress, and no text", async () => {
    const tokens = [];
    const progress = [];
    const r = await openai.parseStreamResponse(sse([
      delta({ tool_calls: [{ index: 0, id: "c1", function: { name: "write_file", arguments: "" } }] }),
      delta({ tool_calls: [{ index: 0, function: { arguments: '{"path":"a.md",' } }] }),
      delta({ tool_calls: [{ index: 0, function: { arguments: '"content":"hello"}' } }] }),
      "data: [DONE]",
    ]), (t) => tokens.push(t), (p) => progress.push(p));

    expect(tokens).toEqual([]);
    expect(progress.map((p) => p.kind)).toEqual(["tool", "tool", "tool"]);
    expect(progress.reduce((n, p) => n + p.chars, 0)).toBe('{"path":"a.md","content":"hello"}'.length + "write_file".length);
    expect(r.message.tool_calls[0].function.arguments).toBe('{"path":"a.md","content":"hello"}');
  });

  it("reports reasoning as progress, in each spelling a provider uses", async () => {
    const progress = [];
    await openai.parseStreamResponse(sse([
      delta({ reasoning: "weighing" }),
      delta({ reasoning_content: "the options" }),
      // Gemini through OpenRouter: the text is withheld, the block still comes.
      delta({ reasoning_details: [{ type: "reasoning.encrypted", data: "x" }] }),
      delta({ content: "done" }),
      "data: [DONE]",
    ]), () => {}, (p) => progress.push(p));

    expect(progress).toEqual([
      { kind: "reasoning", chars: 8 },
      { kind: "reasoning", chars: 11 },
      { kind: "reasoning", chars: 0 },
    ]);
  });

  it("does not take a router's keep-alive comment for the model", async () => {
    // ": OPENROUTER PROCESSING" arrives every few seconds whether or not the
    // model behind the router is doing anything. It proves the router is up.
    const progress = [];
    await openai.parseStreamResponse(sse([
      ": OPENROUTER PROCESSING",
      ": OPENROUTER PROCESSING",
      "data: [DONE]",
    ]), () => {}, (p) => progress.push(p));
    expect(progress).toEqual([]);
  });
});

describe("Anthropic stream", () => {
  const ev = (o) => `event: ${o.type}\n${data(o)}`;
  it("reports thinking and tool input as progress", async () => {
    const tokens = [];
    const progress = [];
    await anthropic.parseStreamResponse(sse([
      ev({ type: "message_start", message: { id: "m1", usage: { input_tokens: 1 } } }),
      ev({ type: "content_block_start", index: 0, content_block: { type: "thinking" } }),
      ev({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } }),
      ev({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t1", name: "write_file" } }),
      ev({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"path":' } }),
      ev({ type: "message_stop" }),
    ]), (t) => tokens.push(t), (p) => progress.push(p));

    expect(tokens).toEqual([]);
    expect(progress).toEqual([
      { kind: "reasoning", chars: 3 },
      { kind: "tool", chars: 8 },
    ]);
  });
});
