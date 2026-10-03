// Acceptance checks 1 and 6 of docs/console-spec.md, on a terminal emulator.
//
// 1. A long session: 2,000 history lines; the live zone keeps redrawing while
//    a turn runs, history is not reprinted, and a redraw does not get slower
//    as history grows.
// 6. Resizing the window mid-turn: no duplicated or torn history lines.
import { describe, it, expect, vi } from "vitest";
import React from "react";
import { EventEmitter } from "node:events";

vi.mock("../../../src/logging/logger.js", () => ({
  createLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
}));

const h = React.createElement;
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));

async function session(cols = 100, rows = 30) {
  const { Terminal } = await import("@xterm/headless");
  const term = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 5000, convertEol: true });
  let bytes = 0;
  const stdout = new EventEmitter();
  Object.assign(stdout, { columns: cols, rows, isTTY: true, write: (s) => { bytes += s.length; term.write(s); return true; } });
  const stdin = new EventEmitter();
  Object.assign(stdin, { isTTY: true, setRawMode() {}, setEncoding() {}, ref() {}, unref() {}, read() { return null; }, resume() {}, pause() {} });
  const saved = { columns: process.stdout.columns, rows: process.stdout.rows };
  process.stdout.columns = cols;
  process.stdout.rows = rows;
  const { render } = await import("ink");
  const { App } = await import("../../../src/components/App.js");
  const { RENDER_OPTIONS } = await import("../../../src/ui/render-options.js");
  const { createMockStore } = await import("../../helpers/mock-store.js");
  const store = createMockStore();
  const inst = render(h(App, { store, onSubmit() {}, onAbort() {}, onQuit() {} }), { ...RENDER_OPTIONS, stdout, stdin, stderr: stdout, patchConsole: false });
  await tick();
  const screen = async () => {
    await new Promise((r) => term.write("", r));
    const buf = term.buffer.active;
    const out = [];
    for (let y = 0; y < buf.length; y++) out.push(buf.getLine(y).translateToString(true));
    return out;
  };
  const resize = (c, r) => {
    term.resize(c, r);
    stdout.columns = c; stdout.rows = r;
    process.stdout.columns = c; process.stdout.rows = r;
    stdout.emit("resize");
  };
  const close = () => { inst.unmount(); process.stdout.columns = saved.columns; process.stdout.rows = saved.rows; };
  return { store, screen, resize, close, bytesWritten: () => bytes };
}

describe("acceptance 1: a long session", () => {
  it("prints 2,000 history lines once each, and live redraws stay as cheap as at the start", async () => {
    const { store, screen, close, bytesWritten } = await session();
    store.getState().setAgentStatus("thinking");
    // Bytes the terminal receives for a burst of live redraws, early on.
    const burst = async () => {
      const before = bytesWritten();
      for (let i = 0; i < 20; i++) { store.getState().setActivity({ kind: "tool", tool: "run_command", arg: `step ${i}` }); await tick(5); }
      await tick(60);
      return bytesWritten() - before;
    };
    const early = await burst();
    for (let i = 0; i < 2000; i++) store.getState().addLine(`history line ${i}`);
    await tick(400);
    const late = await burst();
    const text = (await screen()).join("\n");
    close();
    // Every line once: nothing reprinted.
    for (const i of [0, 999, 1999]) expect(text.split(`history line ${i}\n`).length - 1, `line ${i}`).toBe(1);
    // A redraw does not carry the history with it.
    expect(late).toBeLessThan(early * 2);
  }, 60000);
});

describe("acceptance 6: resize mid-turn", () => {
  it("keeps every history line once, whole, across narrowing and widening", async () => {
    const { store, screen, resize, close } = await session(100, 30);
    store.getState().setAgentStatus("thinking");
    for (let i = 0; i < 30; i++) store.getState().addLine(`before resize ${i}`);
    await tick(100);
    resize(70, 24);
    for (let i = 0; i < 5; i++) { store.getState().setActivity({ kind: "tool", tool: "run_command", arg: `narrow ${i}` }); await tick(20); }
    for (let i = 0; i < 30; i++) store.getState().addLine(`after resize ${i}`);
    await tick(100);
    resize(120, 30);
    for (let i = 0; i < 5; i++) { store.getState().setActivity({ kind: "tool", tool: "run_command", arg: `wide ${i}` }); await tick(20); }
    await tick(150);
    const lines = await screen();
    close();
    const text = lines.join("\n");
    for (const label of ["before resize", "after resize"]) {
      for (const i of [0, 15, 29]) {
        const hits = lines.filter((l) => l.trim() === `${label} ${i}`).length;
        expect(hits, `"${label} ${i}" appears ${hits} times\n${text.slice(-1500)}`).toBe(1);
      }
    }
    // Live rows of earlier frames did not settle into the history.
    expect((text.match(/narrow \d/g) || []).length).toBeLessThanOrEqual(1);
    expect((text.match(/wide \d/g) || []).length).toBeLessThanOrEqual(1);
  }, 60000);
});
