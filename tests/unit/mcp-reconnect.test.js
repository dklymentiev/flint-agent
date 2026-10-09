// The MCP health check retries a down server, but a server that cannot connect
// for a configuration reason must be tried once, said once, and left alone until
// the operator changes something. A transient failure backs off for real.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/logging/logger.js", () => ({
  createLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
}));

// The SDK is faked at the edge: the network is up or down by a flag.
const net = { up: false };
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: function Client() {
    return {
      connect: async () => { if (!net.up) throw new Error("connect ECONNREFUSED 127.0.0.1:9"); },
      listTools: async () => ({ tools: [] }),
      close: async () => {},
    };
  },
}));
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({ StreamableHTTPClientTransport: function () {} }));
vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({ SSEClientTransport: function () {} }));
vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({ StdioClientTransport: function () {} }));

const keys = await import("../../src/providers/keys.js");
const mcp = await import("../../src/mcp-client.js");

const SERVERS = [{ name: "analytics", transport: "http", url: "http://127.0.0.1:9/mcp", headers: { Authorization: "Bearer ${ANALYTICS_TOKEN_T}" } }];
const NO_ENV = {};

// A connect that behaves like the real one for credentials: it expands the
// headers (so a missing secret throws the real McpConfigError) and then, if
// asked, fails the way a dead network does.
function fakeConnect({ network = "ok" } = {}) {
  const fn = vi.fn(async (cfg) => {
    await mcp.expandHeaders(cfg.headers || {}, cfg.name, NO_ENV);
    if (network === "down") throw new Error("connect ECONNREFUSED 127.0.0.1:9");
    return { toolCount: 2, tools: [], handlers: {} };
  });
  return fn;
}

beforeEach(async () => {
  net.up = false;
  await mcp.disconnectAll();
  mcp.resetReconnectState();
  await keys.deleteMcpSecret("ANALYTICS_TOKEN_T");
});

describe("configuration failure", () => {
  it("is tried once and then not again, however many ticks pass", async () => {
    const connect = fakeConnect();
    const first = await mcp.autoReconnectTick(SERVERS, { now: 0, connect, env: NO_ENV });
    expect(first.map((e) => e.type)).toEqual(["attempt", "fatal"]);
    expect(first[1].error).toMatch(/ANALYTICS_TOKEN_T/);
    for (let i = 1; i <= 50; i++) {
      const again = await mcp.autoReconnectTick(SERVERS, { now: i * 60_000, connect, env: NO_ENV });
      expect(again).toEqual([]);
    }
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("is retried once a secret it names is stored, with no restart", async () => {
    const connect = fakeConnect();
    await mcp.autoReconnectTick(SERVERS, { now: 0, connect, env: NO_ENV });
    await keys.setMcpSecret("ANALYTICS_TOKEN_T", "tok");
    const events = await mcp.autoReconnectTick(SERVERS, { now: 1000, connect, env: NO_ENV });
    expect(events.map((e) => e.type)).toEqual(["attempt", "connected"]);
    expect(mcp.getReconnectState("analytics")).toBeUndefined();
  });

  it("is retried when the server config itself changes", async () => {
    const connect = fakeConnect();
    await mcp.autoReconnectTick(SERVERS, { now: 0, connect, env: NO_ENV });
    const changed = [{ ...SERVERS[0], headers: { Authorization: "Bearer plain" } }];
    const events = await mcp.autoReconnectTick(changed, { now: 1000, connect, env: NO_ENV });
    expect(events.map((e) => e.type)).toEqual(["attempt", "connected"]);
  });

  it("is retried when the secret comes from the environment instead", async () => {
    const connect = vi.fn(async (cfg) => {
      await mcp.expandHeaders(cfg.headers, cfg.name, { ANALYTICS_TOKEN_T: "x" });
      return { toolCount: 1, tools: [], handlers: {} };
    });
    await mcp.autoReconnectTick(SERVERS, { now: 0, connect: fakeConnect(), env: NO_ENV });
    const events = await mcp.autoReconnectTick(SERVERS, { now: 1000, connect, env: { ANALYTICS_TOKEN_T: "x" } });
    expect(events.map((e) => e.type)).toEqual(["attempt", "connected"]);
  });

  it("an invalid url is a configuration failure, found by type not by wording", async () => {
    const bad = [{ name: "weird", transport: "http", url: "ftp://nope" }];
    const connect = vi.fn(async () => { throw new mcp.McpConfigError("anything at all"); });
    const first = await mcp.autoReconnectTick(bad, { now: 0, connect, env: NO_ENV });
    expect(first.at(-1).type).toBe("fatal");
    expect(await mcp.autoReconnectTick(bad, { now: 99e6, connect, env: NO_ENV })).toEqual([]);
  });

  it("a plain Error that merely mentions the key store is NOT fatal", async () => {
    const connect = vi.fn(async () => { throw new Error("upstream said: is not in the key store"); });
    const first = await mcp.autoReconnectTick(SERVERS, { now: 0, connect, env: NO_ENV });
    expect(first.at(-1).type).toBe("backoff");
  });
});

describe("manual reconnect", () => {
  it("a success clears the fatal state, so a later disconnect is auto-recovered", async () => {
    await mcp.autoReconnectTick(SERVERS, { now: 0, env: NO_ENV });
    expect(mcp.getReconnectState("analytics").fatal).toBe(true);

    await keys.setMcpSecret("ANALYTICS_TOKEN_T", "tok");
    net.up = true;
    await mcp.reconnectServer("analytics", SERVERS);
    expect(mcp.getReconnectState("analytics")).toBeUndefined();
    expect(mcp.getServerStatus(SERVERS)[0].connected).toBe(true);

    // The server drops later; the health check must pick it up again.
    await mcp.disconnectServer("analytics");
    const events = await mcp.autoReconnectTick(SERVERS, { now: 5000, env: NO_ENV });
    expect(events.map((e) => e.type)).toEqual(["attempt", "connected"]);
  });

  it("a failed manual reconnect is recorded like any other failure", async () => {
    await expect(mcp.reconnectServer("analytics", SERVERS)).rejects.toThrow(/ANALYTICS_TOKEN_T/);
    expect(mcp.getReconnectState("analytics").fatal).toBe(true);
    await keys.setMcpSecret("ANALYTICS_TOKEN_T", "tok");
    await expect(mcp.reconnectServer("analytics", SERVERS)).rejects.toThrow(/ECONNREFUSED/);
    expect(mcp.getReconnectState("analytics")).toMatchObject({ fatal: false, failures: 1 });
  });
});

describe("transient failure", () => {
  it("backs off in fact: 60s, 120s, 240s, capped at 10 min, counted in attempts", async () => {
    const connect = fakeConnect({ network: "down" });
    await keys.setMcpSecret("ANALYTICS_TOKEN_T", "tok");
    // tick every 10s of fake time for 3 hours
    const tickMs = 10_000;
    const attemptTimes = [];
    for (let t = 0; t <= 3 * 3600_000; t += tickMs) {
      const ev = await mcp.autoReconnectTick(SERVERS, { now: t, connect, env: NO_ENV });
      if (ev.some((e) => e.type === "attempt")) attemptTimes.push(t);
    }
    const gaps = attemptTimes.slice(1).map((t, i) => t - attemptTimes[i]);
    expect(gaps.slice(0, 5)).toEqual([60_000, 120_000, 240_000, 480_000, 600_000]);
    expect(Math.max(...gaps)).toBe(600_000);
    // 3 hours at a flat 60 s would be 180 attempts
    expect(attemptTimes.length).toBeLessThan(25);
  });

  it("the delay it reports is the delay it applies", async () => {
    const connect = fakeConnect({ network: "down" });
    await keys.setMcpSecret("ANALYTICS_TOKEN_T", "tok");
    let now = 0;
    for (let n = 1; n <= 4; n++) {
      const ev = await mcp.autoReconnectTick(SERVERS, { now, connect, env: NO_ENV });
      const b = ev.find((e) => e.type === "backoff");
      expect(b.delayMs).toBe(mcp.backoffDelayMs(n));
      const calls = connect.mock.calls.length;
      // just before the reported delay: nothing; at it: an attempt
      expect(await mcp.autoReconnectTick(SERVERS, { now: now + b.delayMs - 1, connect, env: NO_ENV })).toEqual([]);
      expect(connect.mock.calls.length).toBe(calls);
      now += b.delayMs;
    }
  });

  it("a success resets the backoff", async () => {
    await keys.setMcpSecret("ANALYTICS_TOKEN_T", "tok");
    const down = fakeConnect({ network: "down" });
    await mcp.autoReconnectTick(SERVERS, { now: 0, connect: down, env: NO_ENV });
    const up = fakeConnect();
    const ev = await mcp.autoReconnectTick(SERVERS, { now: 60_000, connect: up, env: NO_ENV });
    expect(ev.map((e) => e.type)).toEqual(["attempt", "connected"]);
    expect(mcp.getReconnectState("analytics")).toBeUndefined();
    const ev2 = await mcp.autoReconnectTick(SERVERS, { now: 61_000, connect: down, env: NO_ENV });
    expect(ev2.find((e) => e.type === "backoff").delayMs).toBe(60_000);
  });
});
