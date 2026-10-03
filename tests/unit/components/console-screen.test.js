// What the operator's terminal actually shows.
//
// The real App is rendered with the real render options into a headless
// xterm, and the assertions are about the terminal's screen and scrollback,
// not about Ink's frames. Owner, 2026-10-01: with incrementalRendering on,
// every spinner frame stayed in the scrollback ("/ thinking..." stacked line
// after line); frame-level tests could not see it, a terminal can.
import { describe, it, expect, vi } from "vitest";
import React from "react";
import { EventEmitter } from "node:events";

vi.mock("../../../src/logging/logger.js", () => ({
  createLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
}));

const h = React.createElement;
const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));

async function terminalSession(cols = 80, rows = 24) {
  const { Terminal } = await import("@xterm/headless");
  // convertEol: a real TTY turns \n into \r\n (ONLCR); xterm.js needs telling.
  const term = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 1000, convertEol: true });
  const stdout = new EventEmitter();
  Object.assign(stdout, { columns: cols, rows, isTTY: true, write: (s) => { term.write(s); return true; } });
  const stdin = new EventEmitter();
  Object.assign(stdin, {
    isTTY: true, setRawMode() {}, setEncoding() {}, ref() {}, unref() {},
    read() { return null; }, resume() {}, pause() {},
  });
  const saved = { columns: process.stdout.columns, rows: process.stdout.rows };
  process.stdout.columns = cols;
  process.stdout.rows = rows;

  const { render } = await import("ink");
  const { App } = await import("../../../src/components/App.js");
  const { RENDER_OPTIONS } = await import("../../../src/ui/render-options.js");
  const { createMockStore } = await import("../../helpers/mock-store.js");
  const store = createMockStore();
  const inst = render(
    h(App, { store, onSubmit() {}, onAbort() {}, onQuit() {} }),
    { ...RENDER_OPTIONS, stdout, stdin, stderr: stdout, patchConsole: false },
  );
  await tick();

  const screen = async () => {
    await new Promise((r) => term.write("", r));
    const buf = term.buffer.active;
    const lines = [];
    for (let y = 0; y < buf.length; y++) lines.push(buf.getLine(y).translateToString(true));
    return lines;
  };
  const close = () => {
    inst.unmount();
    process.stdout.columns = saved.columns;
    process.stdout.rows = saved.rows;
  };
  return { store, screen, close };
}

describe("console on a real terminal", () => {
  it("leaves no spinner frames behind in the scrollback", async () => {
    const { store, screen, close } = await terminalSession();
    store.getState().addLine("history line A");
    store.getState().setAgentStatus("thinking");
    const frames = ["/", "-", "\\", "|"];
    for (let i = 0; i < 12; i++) {
      store.getState().setStreamText(`  ${frames[i % 4]} thinking...`);
      await tick(25);
    }
    for (let i = 0; i < 6; i++) {
      // A running tool: its row above the input shows the argument, so each
      // frame is distinct and a leftover one would be visible.
      store.getState().setAgentStatus("calling-tool", "run_command");
      store.getState().setActivity({ kind: "tool", tool: "run_command", arg: `waiting ${i}` });
      await tick(25);
    }
    store.getState().addLine("history line B");
    await tick(150);
    const text = (await screen()).join("\n");
    close();
    // Only the current activity row may show; earlier ones must be gone.
    expect((text.match(/waiting \d/g) || []).length, text).toBeLessThanOrEqual(1);
    expect((text.match(/thinking/g) || []).length, text).toBe(0);
    expect(text.indexOf("history line A")).toBeLessThan(text.indexOf("history line B"));
  }, 30000);

  it("prints a history line once, however often the live zone redraws", async () => {
    const { store, screen, close } = await terminalSession();
    store.getState().addLine("only once");
    for (let i = 0; i < 10; i++) {
      store.getState().setActivity({ kind: "tool", label: `step ${i}` });
      await tick(20);
    }
    await tick(120);
    const text = (await screen()).join("\n");
    close();
    expect(text.split("only once").length - 1).toBe(1);
  }, 30000);
});
