// Integration test: truncated_at flows from the agent result through the
// HTTP API server's sync response (POST /message?sync=true) and the async
// poll (GET /message/:id).
//
// The server pushes a message to the bus, and the drain-loop processes it by
// calling processMessage (imported from message-handler.js). We mock
// processMessage to return a result carrying truncated_at, then verify both
// the sync and async API response paths propagate the field — exactly as
// they already do for repoClaimGap.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
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

vi.mock("../../src/app-state.js", () => ({
  app: {
    apiGoalId: null,
    mcpReady: true,
    queueAborted: false,
    autonomous: false,
  },
}));

// Mock config to avoid MCP readiness wait
vi.mock("../../src/config.js", () => ({
  config: {
    apiKey: "test", model: "test", apiUrl: "https://test.api",
    projectRoot: process.cwd(), maxIterations: 50,
    sessionsDir: "/tmp/flint-test-sessions",
    sessionBudget: 0, maxCostPerAction: 0, headless: false,
    workdir: "", baseDir: "", apiAutoApprove: true,
    mcpServers: [],
  },
}));

// Mock processMessage — the drain-loop imports this from message-handler.js.
// It returns a result shape that _processOne reads to build resultData.
const mockProcessMessage = vi.fn();
vi.mock("../../src/message-handler.js", () => ({
  processMessage: mockProcessMessage,
  handlePendingAction: vi.fn(),
}));

beforeAll(async () => {
  port = await findFreePort();
  store = createMockStore();
  store.getState().setSession("test-session", [
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi" },
  ]);
  store.getState().setModel("test-model");
  store.getState().setPricing({ prompt: 0.000001, completion: 0.000002, contextLength: 128000 });

  const processMessage = () => mockProcessMessage();

  const result = await startServer(port, store, processMessage);
  server = result.server;
});

afterAll(() => {
  if (server) server.close();
});

describe("HTTP server truncated_at propagation", () => {
  it("POST /message?sync=true includes truncated_at in the response", async () => {
    mockProcessMessage.mockReturnValue({
      text: "cut short",
      stats: {},
      stop_reason: "budget",
      truncated_at: { type: "max_iterations", limit: 50, used: 51 },
      toolCalls: [],
      repoClaimGap: false,
    });

    const res = await fetch(`http://127.0.0.1:${port}/message?sync=true`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "do something that hits the step ceiling" }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.truncated_at).toEqual({
      type: "max_iterations", limit: 50, used: 51,
    });
    expect(data.stop_reason).toBe("budget");
    expect(data.repoClaimGap).toBe(false);
  }, 30000);

  it("GET /message/:id includes truncated_at after async processing", async () => {
    mockProcessMessage.mockReturnValue({
      text: "cut short",
      stats: {},
      stop_reason: "budget",
      truncated_at: { type: "max_iterations", limit: 50, used: 51 },
      toolCalls: [],
      repoClaimGap: false,
    });

    const postRes = await fetch(`http://127.0.0.1:${port}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "async test" }),
    });
    expect(postRes.status).toBe(202);
    const posted = await postRes.json();
    const messageId = posted.messageId;
    expect(messageId).toBeDefined();

    let data;
    for (let i = 0; i < 240; i++) {
      const res = await fetch(`http://127.0.0.1:${port}/message/${messageId}`);
      data = await res.json();
      if (data.status === "done") break;
      await new Promise(r => setTimeout(r, 100));
    }

    expect(data.status).toBe("done");
    expect(data.truncated_at).toEqual({
      type: "max_iterations", limit: 50, used: 51,
    });
  }, 30000);
});
