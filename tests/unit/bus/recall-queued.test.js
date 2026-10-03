// Esc on an unread message takes it back for editing (owner, 2026-10-01).
// The real bus module, on the test sandbox's database.
import { describe, it, expect, vi } from "vitest";
import React from "react";
import { render } from "ink-testing-library";

vi.mock("../../../src/logging/logger.js", () => ({
  createLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
}));

describe("bus.cancelPending", () => {
  it("cancels a message still waiting, so the agent never reads it", async () => {
    const bus = await import("../../../src/bus/index.js");
    const { id } = bus.push({ channel: "user", content: "first draft", priority: bus.PRIORITY.USER, source: "tui" });
    expect(bus.cancelPending(id)).toBe(true);
    expect(bus.pending(50).some((m) => m.id === id)).toBe(false);
  });

  it("refuses a message the agent already took", async () => {
    const bus = await import("../../../src/bus/index.js");
    const { id } = bus.push({ channel: "user", content: "taken", priority: bus.PRIORITY.USER, source: "tui" });
    let msg;
    while ((msg = bus.drain())) { if (msg.id === id) break; bus.complete(msg.id, "test"); }
    expect(msg?.id).toBe(id);
    expect(bus.cancelPending(id)).toBe(false);
    bus.complete(id, "test");
  });
});

describe("Esc with unread messages", () => {
  it("puts the newest unread message back in the input", async () => {
    const { App } = await import("../../../src/components/App.js");
    const { createMockStore } = await import("../../helpers/mock-store.js");
    const store = createMockStore();
    store.getState().addQueuedInput({ id: 7, display: "draft one", edit: "draft one" });
    const onRecallQueued = vi.fn(() => "draft one");
    const onAbort = vi.fn();
    const { stdin, lastFrame, unmount } = render(React.createElement(App, { store, onSubmit() {}, onAbort, onQuit() {}, onRecallQueued }));
    const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));
    await tick();
    expect(lastFrame()).toContain("queued  draft one   · Esc to edit");
    stdin.write("\x1b");
    await tick();
    expect(onRecallQueued).toHaveBeenCalledTimes(1);
    expect(onAbort).not.toHaveBeenCalled();
    expect(lastFrame()).toMatch(/> draft one/);
    unmount();
  });

  it("stops the turn as before when nothing is unread", async () => {
    const { App } = await import("../../../src/components/App.js");
    const { createMockStore } = await import("../../helpers/mock-store.js");
    const onAbort = vi.fn();
    const { stdin, unmount } = render(React.createElement(App, { store: createMockStore(), onSubmit() {}, onAbort, onQuit() {}, onRecallQueued: () => null }));
    await new Promise((r) => setTimeout(r, 60));
    stdin.write("\x1b");
    await new Promise((r) => setTimeout(r, 60));
    expect(onAbort).toHaveBeenCalledTimes(1);
    unmount();
  });
});
