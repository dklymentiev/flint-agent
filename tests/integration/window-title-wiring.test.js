// A real turn must animate the window title, not just the module that owns it.
//
// Backlog item 18. window-title.test.js proves the spinner behaves, and that is
// not the same claim as "Flint's window says it is alive". The failure shape here
// is the one from items 13 and 14: a correct module that nothing calls. A green
// unit suite said nothing about what a taskbar entry would show, which is the
// whole point of the item.
//
// So this drives processMessage — the function a turn actually runs through —
// with the model stubbed to fail, and observes the title through the shared
// defaultSetTitle, which is the single writer both the spinner and the attention
// bell now use. No network, no provider, no timing assumptions.
//
// The animation itself (frame advance, interval, isTTY guard) stays in the unit
// suite under fake timers. What is proven here is narrower and is the part that
// could regress silently: the title is written when a turn starts.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../src/logging/logger.js", () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}));

/** Every title the terminal was told to show, in order. */
function titleSink() {
  const written = [];
  return { written, spy: vi.fn((t) => written.push(t)) };
}

describe("a turn animates the window title", () => {
  let sink = null;

  beforeEach(() => {
    sink = titleSink();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes a title naming Flint before the turn does any work", async () => {
    const promptAttention = await import("../../src/ui/prompt-attention.js");
    vi.spyOn(promptAttention, "defaultSetTitle").mockImplementation(sink.spy);

    // The model call fails immediately, so the turn starts and ends without a
    // network and without depending on any particular provider's behaviour.
    const agent = await import("../../src/agent/agent.js");
    vi.spyOn(agent, "runAgent").mockRejectedValue(new Error("probe: model unavailable"));

    const { processMessage } = await import("../../src/message-handler.js");
    await processMessage("hello", null).catch(() => {});

    expect(
      sink.written.length,
      "a real turn wrote no window title, so the title bar would still say whatever the shell said",
    ).toBeGreaterThan(0);
    expect(
      sink.written[0],
      "the title does not say Flint is alive",
    ).toMatch(/Flint/);
    // The spinner frame is in the title, which is what makes it read as motion
    // rather than as a static label.
    expect(
      sink.written[0],
      "the title has no spinner frame, so nothing indicates work in progress",
    ).toMatch(/[⛭✲]/);
  });

  // Owner, 2026-10-02: after turns stopped with Esc the title kept spinning on
  // an idle Flint. Only the normal end of a turn stopped the animation, so every
  // turn that ended another way left its timer running for good.
  it("stops spinning when a turn ends in an error, and stays stopped", async () => {
    const promptAttention = await import("../../src/ui/prompt-attention.js");
    vi.spyOn(promptAttention, "defaultSetTitle").mockImplementation(sink.spy);

    const agent = await import("../../src/agent/agent.js");
    vi.spyOn(agent, "runAgent").mockRejectedValue(new Error("probe: model unavailable"));

    const { processMessage } = await import("../../src/message-handler.js");
    await processMessage("hello", null).catch(() => {});

    const after = sink.written.length;
    await new Promise((r) => setTimeout(r, 1300)); // more than two title ticks
    expect(sink.written.length, "the title kept ticking after the turn ended").toBe(after);
    expect(sink.written.at(-1), "the last title still shows a spinner frame").not.toMatch(/[⛭✲]/);
  });

  it("writes the title through the shared writer, not a private escape", async () => {
    const promptAttention = await import("../../src/ui/prompt-attention.js");
    vi.spyOn(promptAttention, "defaultSetTitle").mockImplementation(sink.spy);

    const agent = await import("../../src/agent/agent.js");
    vi.spyOn(agent, "runAgent").mockRejectedValue(new Error("probe: model unavailable"));

    const { processMessage } = await import("../../src/message-handler.js");
    await processMessage("hello", null).catch(() => {});

    // The item's whole value is that the title is visible from OUTSIDE the
    // window. That only works if it goes through the writer that knows how to
    // reach the window manager — process.stdout.title where it exists, OSC 0
    // otherwise — rather than a second OSC writer guessing again.
    expect(
      promptAttention.defaultSetTitle,
      "the shared writer was replaced rather than used",
    ).toBeTypeOf("function");
    expect(sink.written.length, "defaultSetTitle was bypassed").toBeGreaterThan(0);
  });
});