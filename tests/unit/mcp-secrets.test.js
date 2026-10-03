// A token for an MCP server belongs where the provider keys already are, in
// the encrypted key store, not in .env as plain text (owner, 2026-10-03).
import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

vi.mock("../../src/logging/logger.js", () => ({
  createLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
}));

const keys = await import("../../src/providers/keys.js");
const mcp = await import("../../src/mcp-client.js");

beforeEach(async () => {
  for (const name of keys.listMcpSecrets()) await keys.deleteMcpSecret(name);
});

describe("MCP secrets in the key store", () => {
  it("keeps a secret encrypted and gives it back", async () => {
    await keys.setMcpSecret("ANALYTICS_TOKEN", "plain_value_123");
    expect(await keys.getMcpSecret("ANALYTICS_TOKEN")).toBe("plain_value_123");
    const onDisk = fs.readFileSync(path.join(os.homedir(), ".flint", "keys.enc"), "utf8");
    expect(onDisk).not.toContain("plain_value_123");
  });

  it("lists secret names apart from provider keys", async () => {
    await keys.setKey("openrouter", "sk-provider");
    await keys.setMcpSecret("ANALYTICS_TOKEN", "v");
    expect(keys.listMcpSecrets()).toEqual(["ANALYTICS_TOKEN"]);
    expect(keys.listConfiguredProviders()).toContain("openrouter");
    expect(keys.listConfiguredProviders().some((id) => id.includes("ANALYTICS_TOKEN"))).toBe(false);
    await keys.deleteKey("openrouter");
  });

  it("answers null for a secret that is not there", async () => {
    expect(await keys.getMcpSecret("NOT_THERE")).toBe(null);
  });
});

describe("a header that names a secret", () => {
  it("takes it from the key store before the environment", async () => {
    await keys.setMcpSecret("TOK", "from-store");
    expect(await mcp.expandHeaders({ Authorization: "Bearer ${TOK}" }, "analytics", { TOK: "from-env" }))
      .toEqual({ Authorization: "Bearer from-store" });
  });

  it("falls to the environment when the store has none", async () => {
    expect(await mcp.expandHeaders({ Authorization: "Bearer ${TOK}", "X-Plain": "v" }, "analytics", { TOK: "from-env" }))
      .toEqual({ Authorization: "Bearer from-env", "X-Plain": "v" });
  });

  it("says where to put it when it is in neither", async () => {
    await expect(mcp.expandHeaders({ Authorization: "Bearer ${TOK}" }, "analytics", {}))
      .rejects.toThrow(/TOK[\s\S]*analytics[\s\S]*\/mcp-secret|analytics[\s\S]*TOK[\s\S]*\/mcp-secret/);
  });

  it("reaches the server from the key store", async () => {
    const seen = [];
    const server = http.createServer((req, res) => { seen.push(req.headers); res.writeHead(500); res.end("x"); });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    try {
      await keys.setMcpSecret("FLINT_TEST_STORE_TOKEN", "stored-456");
      delete process.env.FLINT_TEST_STORE_TOKEN;
      await mcp.connectMcpServers([{
        name: "probe", transport: "http", url: `http://127.0.0.1:${server.address().port}/mcp`,
        headers: { Authorization: "Bearer ${FLINT_TEST_STORE_TOKEN}" }, fromFile: true,
      }]);
      expect(seen[0]?.authorization).toBe("Bearer stored-456");
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});

describe("/mcp-secret", () => {
  async function setup() {
    const { createMockStore } = await import("../helpers/mock-store.js");
    const { initCommands, tryHandleCommand } = await import("../../src/commands/registry.js");
    const store = createMockStore();
    initCommands(store);
    const text = () => JSON.stringify(store.getState().lines ?? store.getState());
    return { store, run: (c) => tryHandleCommand(c, store), text };
  }

  // The command waits on the app's secret input; answer it the way the app does.
  async function answerSecret(store, value) {
    for (let i = 0; i < 50 && !store.getState().secretPrompt; i++) await new Promise((r) => setTimeout(r, 5));
    const prompt = store.getState().secretPrompt;
    expect(prompt).toBeTruthy();
    store.setState({ secretPrompt: null });
    prompt.resolve(value);
  }

  it("stores what the operator types in the secret box, and never prints it", async () => {
    const { store, run, text } = await setup();
    const done = run("/mcp-secret ANALYTICS_TOKEN");
    await answerSecret(store, "typed-secret-789");
    await done;
    expect(await keys.getMcpSecret("ANALYTICS_TOKEN")).toBe("typed-secret-789");
    expect(text()).not.toContain("typed-secret-789");
  });

  it("lists names without values and deletes by name", async () => {
    await keys.setMcpSecret("ANALYTICS_TOKEN", "hidden-value");
    const { run, text } = await setup();
    await run("/mcp-secret");
    expect(text()).toContain("ANALYTICS_TOKEN");
    expect(text()).not.toContain("hidden-value");

    await run("/mcp-secret ANALYTICS_TOKEN delete");
    expect(keys.listMcpSecrets()).toEqual([]);
  });

  it("refuses a name a header could not refer to", async () => {
    const { store, run } = await setup();
    await run("/mcp-secret bad-name!");
    expect(store.getState().secretPrompt ?? null).toBe(null);
    expect(keys.listMcpSecrets()).toEqual([]);
  });
});
