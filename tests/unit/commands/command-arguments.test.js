// Commands get their argument through the real dispatcher, not only the ones
// on its hand-written prefix list (owner, 2026-10-01: "/kill 1" answered
// "unknown command").
import { describe, it, expect, vi } from "vitest";

vi.mock("../../../src/logging/logger.js", () => ({
  createLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
}));

async function setup() {
  const { createMockStore } = await import("../../helpers/mock-store.js");
  const { initCommands, tryHandleCommand } = await import("../../../src/commands/registry.js");
  const store = createMockStore();
  initCommands(store);
  const text = () => store.getState().lines.map((l) => String(l.text).replace(/\x1b\[[0-9;]*m/g, "")).join("\n");
  return { store, run: (c) => tryHandleCommand(c, store), text };
}

describe("command arguments through tryHandleCommand", () => {
  it("/kill <id> and /logs <id>", async () => {
    const { store, run, text } = await setup();
    const id = store.getState().addProcess({ cmd: "ping", pid: 0 });
    store.getState().appendProcessOutput(id, "Reply from 127.0.0.1");
    expect(await run(`/logs ${id}`)).toBe(true);
    expect(text()).toContain("Reply from 127.0.0.1");
    // pid 0: nothing real to kill, so the command answers that it is not
    // running. What is tested is that /kill got its argument at all.
    expect(await run(`/kill ${id}`)).toBe(true);
    expect(text()).toContain(`bg ${id} is not running`);
  });

  it("/tools <n>", async () => {
    const { run } = await setup();
    expect(await run("/tools 5")).toBe(true);
  });

  it("still says no to a command that does not exist", async () => {
    const { run } = await setup();
    expect(await run("/nosuchcommand 1")).toBe(false);
  });

  it("does not treat a path as a command", async () => {
    const { run } = await setup();
    expect(await run("/work/match.mp4 is 12 seconds")).toBe(false);
  });
});
