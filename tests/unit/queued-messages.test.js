// Messages typed while the agent works are taken into the running turn between
// steps, and the console says when (owner, 2026-10-01: "(queued)" stayed on
// screen with no sign the messages had been read).
import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/logging/logger.js", () => ({
  createLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
}));

function fakeBus(items) {
  const queue = [...items];
  const completed = [];
  return {
    completed,
    pending: (n) => queue.slice(0, n),
    drain: () => queue.shift() || null,
    complete: (id, why) => completed.push({ id, why }),
  };
}

async function setup() {
  const { takeQueuedMessages } = await import("../../src/message-handler.js");
  const { createMockStore } = await import("../helpers/mock-store.js");
  const store = createMockStore();
  const text = () => store.getState().lines.map((l) => String(l.text).replace(/\x1b\[[0-9;]*m/g, "")).join("\n");
  return { takeQueuedMessages, store, text };
}

describe("takeQueuedMessages", () => {
  it("takes every queued operator message and says it read them", async () => {
    const { takeQueuedMessages, store, text } = await setup();
    const bus = fakeBus([
      { id: 1, channel: "user", content: "first" },
      { id: 2, channel: "user", content: "second" },
      { id: 3, channel: "user", content: "third" },
    ]);
    expect(takeQueuedMessages(bus, store)).toEqual(["first", "second", "third"]);
    expect(bus.completed.map((c) => c.id)).toEqual([1, 2, 3]);
    expect(text()).toContain("✓ read all 3");
  });

  it("says nothing when there is nothing queued", async () => {
    const { takeQueuedMessages, store, text } = await setup();
    expect(takeQueuedMessages(fakeBus([]), store)).toBe(null);
    expect(text()).not.toContain("✓ read");
  });

  it("leaves the queue alone when an API message is waiting in it", async () => {
    const { takeQueuedMessages, store } = await setup();
    const bus = fakeBus([{ id: 1, channel: "user", content: "hi" }, { id: 2, channel: "api", content: "task" }]);
    expect(takeQueuedMessages(bus, store)).toBe(null);
    expect(bus.completed).toEqual([]);
  });
});

describe("unread messages above the input", () => {
  it("move into the history, in order, when the turn reads them", async () => {
    const { takeQueuedMessages, store } = await setup();
    store.getState().addQueuedInput({ id: 1, display: "first" });
    store.getState().addQueuedInput({ id: 2, display: "second" });
    const printed = [];
    takeQueuedMessages(fakeBus([{ id: 1, channel: "user", content: "first" }, { id: 2, channel: "user", content: "second" }]), store, { printUserLine: (t) => printed.push(t) });
    expect(printed).toEqual(["first", "second"]);
    expect(store.getState().queuedInputs).toEqual([]);
  });

  it("are listed above the input, the latest three and a count of the rest", async () => {
    const { queueRows } = await import("../../src/components/LiveZone.js");
    const rows = queueRows([1, 2, 3, 4].map((id) => ({ id, display: `msg ${id}` })));
    expect(rows).toEqual(["  queued  … 1 earlier, not read yet", "  queued  msg 2", "  queued  msg 3", "  queued  msg 4   · Esc to edit"]);
  });
});

describe("approval rows", () => {
  // The whole command, never a cut one: the dangerous part may sit exactly
  // where it would be cut (owner, 2026-10-01).
  const cmd = `cd /tmp && echo ${"a".repeat(150)} && rm -rf ./build && echo done`;

  it("put the keys first and the whole command under them, wrapped", async () => {
    const { confirmRows } = await import("../../src/components/LiveZone.js");
    const rows = confirmRows({ pendingConfirmation: "run_command", pendingConfirmationArgs: cmd }, Date.now(), 100);
    expect(rows[0]).toBe("  ? run_command    [y] yes  [n] no  [a] always");
    const shown = rows.slice(1).map((r) => r.slice(4)).join("");
    expect(shown).toBe(cmd);
    for (const r of rows) expect(r.length).toBeLessThanOrEqual(99);
  });

  it("point to the history when the command is too long for the live zone", async () => {
    const { confirmRows, APPROVAL_MAX_ROWS } = await import("../../src/components/LiveZone.js");
    const rows = confirmRows({ pendingConfirmation: "run_command", pendingConfirmationArgs: "x".repeat(2000) }, Date.now(), 100);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toContain("full command printed above");
    expect(APPROVAL_MAX_ROWS).toBeGreaterThan(0);
  });

  it("are given the full arguments, not the 60-character log form", async () => {
    const { formatToolArgsFull } = await import("../../src/ui/header.js");
    expect(formatToolArgsFull({ command: cmd, timeout_seconds: 180 })).toBe(`${cmd}  timeout_seconds=180`);
  });
});
