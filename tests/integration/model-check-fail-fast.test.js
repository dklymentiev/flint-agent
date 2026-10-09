// The model check against a real Flint subprocess and a fake provider: a
// model the provider says does not exist (404) or refuses (401) must end the
// check in seconds as "unavailable", not wait out the task timeout six times,
// and must never be saved as a score. No paid model call: the provider is an
// HTTP server in this test.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const mc = await import("../../src/model-check.js");

let savedDataDir;
let dataDir;
let home;
beforeAll(() => {
  savedDataDir = process.env.FLINT_DATA_DIR;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "flint-ff-data-"));
  process.env.FLINT_DATA_DIR = dataDir;
  home = fs.mkdtempSync(path.join(os.tmpdir(), "flint-ff-home-"));
  fs.mkdirSync(path.join(home, ".flint"), { recursive: true });
});
afterAll(() => {
  if (savedDataDir === undefined) delete process.env.FLINT_DATA_DIR; else process.env.FLINT_DATA_DIR = savedDataDir;
  mc.setCheckAgentFactory(null);
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
});

function fakeProvider(status, body) {
  const hits = { chat: 0 };
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (req.url === "/chat/completions") hits.chat++;
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({
    port: server.address().port, hits, close: () => new Promise((r) => server.close(r)),
  })));
}

function useProvider(port) {
  fs.writeFileSync(path.join(home, ".flint", "providers.json"), JSON.stringify({
    openai: { name: "OpenAI", format: "openai", baseUrl: `http://127.0.0.1:${port}`, authType: "bearer",
      modelsEndpoint: "/models", keyRequired: true, defaultModel: "gpt-4o" },
  }));
  mc.setCheckAgentFactory(({ model, cwd }) => mc.startStdioAgent({
    model, cwd,
    args: ["--provider", "openai"],
    env: { HOME: home, USERPROFILE: home, OPENAI_API_KEY: "sk-fake", OPENROUTER_API_KEY: "", FLINT_API_RETRY_MS: "0", FLINT_OWN_ENV: "0" },
  }));
}

describe("fail fast on a definite provider verdict (real stdio agent, fake provider)", () => {
  it("404 model-not-found: unavailable within seconds, one task tried, nothing saved", async () => {
    const p = await fakeProvider(404, { error: { message: "model not found" } });
    useProvider(p.port);
    const t0 = Date.now();
    const res = await mc.runCheck("gone/model", {});
    const secs = (Date.now() - t0) / 1000;
    await p.close();
    expect(res.unavailable).toMatch(/404/);
    expect(res.score).toBeNull();
    expect(res.tasks).toHaveLength(1);
    expect(secs).toBeLessThan(60);   // the task timeout is 120 s; six of them would be 720 s
    expect(mc.loadChecks()["gone/model"]).toBeUndefined();
  }, 120000);

  it("401: unavailable too", async () => {
    const p = await fakeProvider(401, { error: { message: "bad key" } });
    useProvider(p.port);
    const res = await mc.runCheck("locked/model", {});
    await p.close();
    expect(res.unavailable).toMatch(/401|auth/i);
    expect(mc.loadChecks()["locked/model"]).toBeUndefined();
  }, 120000);
});

describe("a fresh agent per task (real stdio agents, fake provider)", () => {
  it("the request for task 6 does not carry tasks 1 to 5", async () => {
    const sizes = [];
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        let body = null; try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {}
        if (req.url !== "/chat/completions" || !body) { res.writeHead(200, { "Content-Type": "application/json" }); res.end("{\"data\":[]}"); return; }
        const answer = "ready";
        if (body.stream) {
          sizes.push(body.messages.filter((m) => m.role !== "system").length);
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          const chunk = (delta, extra = {}) => `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta, ...extra }] })}\n\n`;
          res.end(chunk({ role: "assistant", content: answer }) + chunk({}, { finish_reason: "stop" }) + "data: [DONE]\n\n");
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ id: "c", object: "chat.completion", created: 1, model: "m", choices: [{ index: 0, message: { role: "assistant", content: answer }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
        }
      });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    useProvider(server.address().port);
    const res = await mc.runCheck("ctx/model", {});
    await new Promise((r) => server.close(r));
    expect(res.unavailable).toBeUndefined();
    expect(res.tasks).toHaveLength(6);
    expect(sizes.length).toBeGreaterThanOrEqual(6);
    // One user message (plus at most a tool round) per task; a shared
    // conversation would reach 11 or more by task 6.
    expect(Math.max(...sizes)).toBeLessThanOrEqual(3);
  }, 240000);
});
