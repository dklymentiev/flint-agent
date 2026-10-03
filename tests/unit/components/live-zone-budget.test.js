// The live output never reaches the window's height, whatever is on screen
// (owner, 2026-10-01). At that height Ink clears the terminal and reprints the
// whole session on every render: the flicker the console rework removed.
import { describe, it, expect, vi, afterEach } from "vitest";
import React from "react";
import { render } from "ink-testing-library";

vi.mock("../../../src/logging/logger.js", () => ({
  createLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
}));

const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));
const saved = { rows: process.stdout.rows, columns: process.stdout.columns };
afterEach(() => { process.stdout.rows = saved.rows; process.stdout.columns = saved.columns; });

const BIG = Array.from({ length: 40 }, (_, i) => `pasted line ${i + 1}`).join("\n");

async function loaded(rows, { approval }) {
  process.stdout.rows = rows;
  process.stdout.columns = 100;
  const { App } = await import("../../../src/components/App.js");
  const { createMockStore } = await import("../../helpers/mock-store.js");
  const store = createMockStore();
  for (let i = 0; i < 10; i++) {
    const id = store.getState().addProcess({ cmd: `job ${i}`, pid: 0 });
    store.getState().appendProcessOutput(id, `output of job ${i}`);
  }
  for (let i = 0; i < 8; i++) store.getState().addQueuedInput({ id: 100 + i, display: `unread message ${i}`, edit: `unread message ${i}` });
  store.getState().setAgentStatus("calling-tool", "run_command");
  store.getState().setActivity({ kind: "tool", tool: "run_command", arg: "npm run build" });
  if (approval) {
    store.setState({ pendingConfirmation: { toolName: "run_command", argsText: `echo ${"x".repeat(900)} && rm -rf ./build`, resolve() {} } });
  }
  const r = render(React.createElement(App, { store, onSubmit() {}, onAbort() {}, onQuit() {} }));
  await tick();
  if (!approval) {
    r.stdin.write(BIG); // a paste: token + preview block
    await tick();
    r.stdin.write(" and a long typed explanation ".repeat(30));
    await tick();
  }
  return r;
}

describe("live zone height budget", () => {
  for (const rows of [10, 12, 16, 24, 40]) {
    for (const approval of [false, true]) {
      it(`stays below a ${rows}-row window${approval ? " with an approval waiting" : ""}`, async () => {
        const { lastFrame, unmount } = await loaded(rows, { approval });
        const height = lastFrame().split("\n").length;
        unmount();
        expect(height, lastFrame()).toBeLessThan(rows);
      });
    }
  }

  it("keeps the approval's keys and the whole command, or points to the history", async () => {
    const { lastFrame, unmount } = await loaded(12, { approval: true });
    const frame = lastFrame();
    unmount();
    expect(frame).toContain("[y] yes  [n] no  [a] always");
    expect(frame).toMatch(/full command printed above|rm -rf \.\/build/);
  });
});
