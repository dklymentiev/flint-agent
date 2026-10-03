import { describe, it, expect, beforeAll, afterAll } from "vitest";
import net from "node:net";
import { startServer } from "../../src/api/server.js";
import { createMockStore } from "../helpers/mock-store.js";

let server;
let port;
let store;

function findFreePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

beforeAll(async () => {
  port = await findFreePort();

  store = createMockStore();
  store.getState().setSession("test-session", [
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi" },
  ]);
  store.getState().setModel("test-model");
  store.getState().setPricing({ prompt: 0.000001, completion: 0.000002, contextLength: 128000 });

  const processMessage = async (content, name) => {
    return { response: `Echo: ${content}`, stats: {} };
  };

  const result = await startServer(port, store, processMessage);
  server = result.server;
});

afterAll(() => {
  if (server) server.close();
});

describe("HTTP server integration", () => {
  it("POST /message — async mode returns 202 with messageId", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "test message" }),
    });
    expect(res.status).toBe(202);
    const data = await res.json();
    expect(data.messageId).toBeDefined();
    expect(data.status).toBe("pending");
  });

  it("POST /message — returns 400 without content", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("content");
  });

  it("GET /status — returns session info", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/status`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.model).toBe("test-model");
    expect(data.messages).toBeGreaterThanOrEqual(0);
    expect(data.alive).toBe(true);
  });

  it("GET /history — returns messages", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/history`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.messages).toHaveLength(2);
    expect(data.messages[0].content).toBe("hello");
  });

  it("GET /model — returns model and pricing", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/model`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.model).toBe("test-model");
    expect(data.pricing).toBeDefined();
  });

  it("GET /unknown — returns 404", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/nonexistent`);
    expect(res.status).toBe(404);
  });

  it("OPTIONS — returns 204 for CORS preflight", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/message`, {
      method: "OPTIONS",
    });
    expect(res.status).toBe(204);
  });
});
