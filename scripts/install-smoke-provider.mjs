// A stand-in model API for scripts/install-smoke.sh: answers every chat
// request with the one word "ready", in the OpenAI-compatible shape Flint
// speaks, so the smoke test needs no key and no network.
//
//   node install-smoke-provider.mjs <port-file>
//
// Listens on a free port of 127.0.0.1 and writes the number to <port-file>.

import http from "node:http";
import { writeFileSync } from "node:fs";

const portFile = process.argv[2];
if (!portFile) {
  console.error("usage: install-smoke-provider.mjs <port-file>");
  process.exit(2);
}

const USAGE = { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 };

function chunk(delta, extra = {}) {
  return `data: ${JSON.stringify({
    id: "chatcmpl-smoke",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "fixture/model",
    choices: [{ index: 0, delta, finish_reason: null, ...extra }],
  })}\n\n`;
}

const server = http.createServer((req, res) => {
  const body = [];
  req.on("data", (c) => body.push(c));
  req.on("end", () => {
    let parsed = {};
    try { parsed = JSON.parse(Buffer.concat(body).toString("utf-8")); } catch {}

    if (!req.url.endsWith("/chat/completions")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "fixture/model", name: "fixture/model" }] }));
      return;
    }
    if (parsed.stream) {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      res.write(chunk({ role: "assistant", content: "" }));
      res.write(chunk({ content: "ready" }));
      res.write(chunk({}, { finish_reason: "stop" }));
      res.write(`data: ${JSON.stringify({ id: "chatcmpl-smoke", object: "chat.completion.chunk", model: "fixture/model", choices: [], usage: USAGE })}\n\n`);
      res.end("data: [DONE]\n\n");
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      id: "chatcmpl-smoke",
      object: "chat.completion",
      model: "fixture/model",
      choices: [{ index: 0, message: { role: "assistant", content: "ready" }, finish_reason: "stop" }],
      usage: USAGE,
    }));
  });
});

server.listen(0, "127.0.0.1", () => {
  writeFileSync(portFile, String(server.address().port));
});
