// MCP servers with headers in the console (owner, 2026-10-03). A server that
// wants a token in `Authorization` could only be configured in stdio mode,
// where .mcp.json is read; in the console MCP_SERVERS is name|transport|url
// and has nowhere to put a header, so one server needed a local bridge
// process whose only job was to add the header.
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

vi.mock("../../src/logging/logger.js", () => ({
  createLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
}));

const mcp = await import("../../src/mcp-client.js");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flint-mcp-user-"));
const file = path.join(dir, "mcp.json");
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
beforeEach(() => { try { fs.unlinkSync(file); } catch {} });

const write = (obj) => fs.writeFileSync(file, typeof obj === "string" ? obj : JSON.stringify(obj));

describe("the user's MCP file", () => {
  it("passes agent identity to MCP children without the model provider key", () => {
    const env = mcp.mcpChildEnv({ MCP_OWN_KEY: "server-only" }, {
      SN_AGENT_SLUG: "pebble", OPENROUTER_API_KEY: "model-only",
      OPENAI_API_KEY: "model-only", ANTHROPIC_API_KEY: "model-only",
    });
    expect(env.SN_AGENT_SLUG).toBe("pebble");
    expect(env.MCP_OWN_KEY).toBe("server-only");
    expect(env.OPENROUTER_API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("is looked for in the data folder", () => {
    expect(mcp.userMcpConfigPath({ FLINT_DATA_DIR: dir })).toBe(file);
    expect(mcp.userMcpConfigPath({})).toBe(path.join(os.homedir(), ".flint", "mcp.json"));
  });

  it("changes nothing when there is no file", () => {
    expect(mcp.withUserMcpServers("a|http|http://127.0.0.1:1/mcp", { file })).toBe(null);
  });

  it("adds its servers, headers included, to those from MCP_SERVERS", () => {
    write({ mcpServers: { analytics: { type: "http", url: "https://example.test/mcp", headers: { Authorization: "Bearer ${ANALYTICS_TOKEN}" } } } });
    const servers = mcp.withUserMcpServers("notes|http|http://127.0.0.1:1/mcp", { file });
    expect(servers.map((s) => s.name)).toEqual(["notes", "analytics"]);
    expect(servers[1]).toMatchObject({ transport: "http", url: "https://example.test/mcp", headers: { Authorization: "Bearer ${ANALYTICS_TOKEN}" } });
  });

  it("takes a server named in both places from the file, once", () => {
    write({ mcpServers: { analytics: { type: "http", url: "https://direct.test/mcp" } } });
    const servers = mcp.withUserMcpServers("analytics|stdio|/usr/bin/node bridge.mjs,notes|http|http://127.0.0.1:1/mcp", { file });
    expect(servers.map((s) => s.name).sort()).toEqual(["analytics", "notes"]);
    expect(servers.find((s) => s.name === "analytics").url).toBe("https://direct.test/mcp");
  });

  it("says which file is broken instead of taking the other servers down", () => {
    write("{ not json");
    expect(() => mcp.withUserMcpServers("notes|http|http://127.0.0.1:1/mcp", { file })).toThrow(file);
  });
});

describe("a header that names an environment variable", () => {
  it("is filled in from the environment", async () => {
    expect(await mcp.expandHeaders({ Authorization: "Bearer ${TOK}", "X-Plain": "v" }, "analytics", { TOK: "abc" }))
      .toEqual({ Authorization: "Bearer abc", "X-Plain": "v" });
  });

  it("is an error that names the variable and the server when it is not set", async () => {
    await expect(mcp.expandHeaders({ Authorization: "Bearer ${TOK}" }, "analytics", {}))
      .rejects.toThrow(/TOK[\s\S]*analytics|analytics[\s\S]*TOK/);
  });

  it("is an error when the variable is set but empty, so no empty token is sent", async () => {
    await expect(mcp.expandHeaders({ Authorization: "Bearer ${TOK}" }, "analytics", { TOK: "" })).rejects.toThrow(/TOK/);
  });
});

describe("on the wire", () => {
  let server;
  let seen;
  let url;

  beforeEach(async () => {
    seen = [];
    server = http.createServer((req, res) => {
      seen.push(req.headers);
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("not an MCP server");
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${server.address().port}/mcp`;
  });
  afterEach(() => new Promise((r) => server.close(r)));

  it("sends the configured header to the server", async () => {
    process.env.FLINT_TEST_MCP_TOKEN = "secret-123";
    try {
      write({ mcpServers: { probe: { type: "http", url, headers: { Authorization: "Bearer ${FLINT_TEST_MCP_TOKEN}" } } } });
      const out = await mcp.connectMcpServers(mcp.withUserMcpServers(null, { file }));
      expect(out.results[0].ok).toBe(false); // the stand-in answers 500, it is the request that matters
      expect(seen.length).toBeGreaterThan(0);
      expect(seen[0].authorization).toBe("Bearer secret-123");
    } finally {
      delete process.env.FLINT_TEST_MCP_TOKEN;
    }
  });

  it("does not call a server whose header variable is missing, and connects the rest", async () => {
    delete process.env.FLINT_TEST_MCP_MISSING;
    write({ mcpServers: {
      broken: { type: "http", url, headers: { Authorization: "Bearer ${FLINT_TEST_MCP_MISSING}" } },
      plain: { type: "http", url },
    } });
    const out = await mcp.connectMcpServers(mcp.withUserMcpServers(null, { file }));
    const broken = out.results.find((r) => r.name === "broken");
    expect(broken.ok).toBe(false);
    expect(broken.error).toMatch(/FLINT_TEST_MCP_MISSING/);
    // Only "plain" reached the server, and without an Authorization header.
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((h) => h.authorization === undefined)).toBe(true);
  });

  it("keeps header values out of the status list", async () => {
    process.env.FLINT_TEST_MCP_TOKEN = "secret-123";
    try {
      write({ mcpServers: { probe: { type: "http", url, headers: { Authorization: "Bearer ${FLINT_TEST_MCP_TOKEN}" } } } });
      const servers = mcp.withUserMcpServers(null, { file });
      expect(JSON.stringify(mcp.getServerStatus(servers))).not.toContain("secret-123");
      expect(JSON.stringify(mcp.getServerStatus(servers))).not.toContain("Authorization");
    } finally {
      delete process.env.FLINT_TEST_MCP_TOKEN;
    }
  });
});
