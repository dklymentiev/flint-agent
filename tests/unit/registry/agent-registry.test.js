// Tests for agent instance registry (src/registry.js)
// Validates: registerAgent, unregisterAgent, listAgents

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

// We need to intercept the file system calls so registry uses a temp file
// instead of the real ~/.flint/agents.json
let tmpDir;
let registryPath;

// Mock the registry module's file paths by mocking fs + homedir
vi.mock("node:os", async () => {
  const actual = await vi.importActual("node:os");
  return {
    ...actual,
    homedir: vi.fn(),
  };
});

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "flint-reg-test-"));
  // Create .flint dir in tmpDir
  fs.mkdirSync(path.join(tmpDir, ".flint"), { recursive: true });
  registryPath = path.join(tmpDir, ".flint", "agents.json");

  // Point homedir() to our temp dir
  const osModule = await import("node:os");
  osModule.homedir.mockReturnValue(tmpDir);
});

afterEach(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.resetModules();
});

async function getRegistryFns() {
  // Dynamic import each time to pick up fresh module state after resetModules
  const mod = await import("../../../src/registry.js");
  return mod;
}

describe("agent registry", () => {
  it("registerAgent adds entry to file", async () => {
    const { registerAgent, listAgents } = await getRegistryFns();
    registerAgent({ port: 3000, sessionId: "s1", model: "gpt-4", profile: "desktop", pid: 1111, provider: "openai", visible: true });

    const agents = await listAgents();
    expect(agents).toHaveLength(1);
    expect(agents[0].port).toBe(3000);
    expect(agents[0].pid).toBe(1111);
    expect(agents[0].model).toBe("gpt-4");
    expect(agents[0].profile).toBe("desktop");
  });

  it("unregisterAgent removes entry by pid", async () => {
    const { registerAgent, unregisterAgent, listAgents } = await getRegistryFns();
    registerAgent({ port: 3000, sessionId: "s1", model: "m1", pid: 2222 });
    registerAgent({ port: 3001, sessionId: "s2", model: "m2", pid: 3333 });

    unregisterAgent(2222);
    const agents = await listAgents();
    expect(agents).toHaveLength(1);
    expect(agents[0].pid).toBe(3333);
  });

  it("listAgents returns all registered agents", async () => {
    const { registerAgent, listAgents } = await getRegistryFns();
    registerAgent({ port: 3000, sessionId: "s1", model: "m1", pid: 1000 });
    registerAgent({ port: 3001, sessionId: "s2", model: "m2", pid: 1001 });
    registerAgent({ port: 3002, sessionId: "s3", model: "m3", pid: 1002 });

    const agents = await listAgents();
    expect(agents).toHaveLength(3);
    const ports = agents.map((a) => a.port);
    expect(ports).toContain(3000);
    expect(ports).toContain(3001);
    expect(ports).toContain(3002);
  });

  it("duplicate registration replaces existing entry with same pid", async () => {
    const { registerAgent, listAgents } = await getRegistryFns();
    registerAgent({ port: 3000, sessionId: "s1", model: "m1", pid: 5555 });
    // Re-register same pid with different port
    registerAgent({ port: 3099, sessionId: "s1-new", model: "m1", pid: 5555 });

    const agents = await listAgents();
    expect(agents).toHaveLength(1);
    expect(agents[0].port).toBe(3099);
    expect(agents[0].pid).toBe(5555);
  });

  it("unregister nonexistent pid is graceful (no throw)", async () => {
    const { registerAgent, unregisterAgent, listAgents } = await getRegistryFns();
    registerAgent({ port: 3000, sessionId: "s1", model: "m1", pid: 6666 });

    // Unregister a pid that does not exist -- should not throw
    expect(() => unregisterAgent(9999)).not.toThrow();

    // Original entry remains
    const agents = await listAgents();
    expect(agents).toHaveLength(1);
    expect(agents[0].pid).toBe(6666);
  });

  it("survives multiple register/unregister cycles", async () => {
    const { registerAgent, unregisterAgent, listAgents } = await getRegistryFns();

    // Cycle 1: register 3, remove 2
    registerAgent({ port: 3010, sessionId: "a", model: "m", pid: 100 });
    registerAgent({ port: 3011, sessionId: "b", model: "m", pid: 101 });
    registerAgent({ port: 3012, sessionId: "c", model: "m", pid: 102 });
    unregisterAgent(100);
    unregisterAgent(101);

    let agents = await listAgents();
    expect(agents).toHaveLength(1);
    expect(agents[0].pid).toBe(102);

    // Cycle 2: add more
    registerAgent({ port: 3020, sessionId: "d", model: "m", pid: 200 });
    registerAgent({ port: 3021, sessionId: "e", model: "m", pid: 201 });
    unregisterAgent(102);

    agents = await listAgents();
    expect(agents).toHaveLength(2);
    const pids = agents.map((a) => a.pid);
    expect(pids).toContain(200);
    expect(pids).toContain(201);

    // Cycle 3: remove all
    unregisterAgent(200);
    unregisterAgent(201);
    agents = await listAgents();
    expect(agents).toHaveLength(0);
  });

  it("sets default profile to 'desktop' when not provided", async () => {
    const { registerAgent, listAgents } = await getRegistryFns();
    registerAgent({ port: 3000, sessionId: "s1", model: "m", pid: 7777 });

    const agents = await listAgents();
    expect(agents[0].profile).toBe("desktop");
  });

  it("includes startedAt timestamp", async () => {
    const { registerAgent, listAgents } = await getRegistryFns();
    registerAgent({ port: 3000, sessionId: "s1", model: "m", pid: 8888 });

    const agents = await listAgents();
    expect(agents[0].startedAt).toBeDefined();
    expect(agents[0].startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
