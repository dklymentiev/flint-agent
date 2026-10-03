// The console from docs/console-spec.md: history printed once into scrollback,
// a small bounded live zone, background output kept out of the chat.
import { describe, it, expect, vi } from "vitest";
import React from "react";
import { render } from "ink-testing-library";

vi.mock("../../../src/logging/logger.js", () => ({
  createLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
}));

const h = React.createElement;
const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));
const plain = (s) => String(s).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

async function mount(storeSetup) {
  const { App } = await import("../../../src/components/App.js");
  const { createMockStore } = await import("../../helpers/mock-store.js");
  const store = createMockStore();
  storeSetup?.(store);
  const onAbort = vi.fn();
  const onQuit = vi.fn();
  const r = render(h(App, { store, onSubmit() {}, onAbort, onQuit }));
  await tick();
  return { ...r, store, onAbort, onQuit, all: () => plain(r.stdout.frames.join("")) };
}

describe("history", () => {
  it("prints each line once", async () => {
    const { store, all, unmount } = await mount();
    store.getState().addLine("first answer line");
    await tick();
    store.getState().addLine("second answer line");
    await tick();
    const out = all();
    expect(out.split("first answer line").length - 1).toBe(1);
    expect(out).toContain("second answer line");
    unmount();
  });

  it("keeps printing after the line buffer hits its cap", async () => {
    // The old <Static> stopped printing once `lines` reached maxDisplayLines.
    const { store, all, unmount } = await mount();
    const max = 1000;
    for (let i = 0; i < max + 5; i++) store.getState().addLine(`line ${i}`);
    await tick();
    store.getState().addLine("after the cap");
    await tick();
    expect(all()).toContain("after the cap");
    unmount();
  });

  it("is not part of the live frame", async () => {
    const { store, lastFrame, unmount } = await mount();
    store.getState().addLine("history only");
    await tick();
    // The last stdout write is the history line itself; force a live redraw
    // and read that frame instead.
    store.setState({ model: "test-model" });
    await tick();
    expect(plain(lastFrame())).toContain("test-model");
    expect(plain(lastFrame())).not.toContain("history only");
    unmount();
  });
});

describe("live zone", () => {
  it("stays small with background processes running", async () => {
    const { liveZoneRows, DOCK_ROWS } = await import("../../../src/components/LiveZone.js");
    const processes = Array.from({ length: 10 }, (_, i) => ({ id: i + 1, cmd: `job ${i}`, status: "running", output: ["x"] }));
    const rows = liveZoneRows({ agentStatus: "calling-tool", activity: { label: "running x" }, pendingConfirmation: "run_command", processes });
    expect(rows).toBeLessThanOrEqual(2 + DOCK_ROWS);
  });

  it("shows a running process in the dock, not in the chat", async () => {
    const { store, all, lastFrame, unmount } = await mount((s) => {
      const id = s.getState().addProcess({ cmd: "npm run dev", pid: 1 });
      s.getState().appendProcessOutput(id, "listening on 5173");
    });
    await tick();
    expect(plain(lastFrame())).toContain("[bg 1] npm run dev");
    store.getState().appendProcessOutput(1, "hot reload done");
    await tick();
    // Its output may show as the dock's last line, but never as history.
    const history = all().replace(plain(lastFrame()), "");
    expect(history).not.toContain("hot reload done");
    unmount();
  });

  it("counts background processes in the status line", async () => {
    const { lastFrame, unmount } = await mount((s) => {
      s.getState().addProcess({ cmd: "a", pid: 1 });
      s.getState().addProcess({ cmd: "b", pid: 2 });
    });
    expect(plain(lastFrame())).toContain("2 bg");
    unmount();
  });
});

describe("keys", () => {
  it("Ctrl+C twice within 2 s quits", async () => {
    const { stdin, onQuit, unmount } = await mount();
    stdin.write("\x03");
    await tick();
    expect(onQuit).not.toHaveBeenCalled();
    stdin.write("\x03");
    await tick();
    expect(onQuit).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("Ctrl+C stops a running turn", async () => {
    const { stdin, onAbort, unmount } = await mount((s) => s.getState().setAgentStatus("thinking"));
    stdin.write("\x03");
    await tick();
    expect(onAbort).toHaveBeenCalledTimes(1);
    unmount();
  });
});

describe("process commands", () => {
  async function cmds() {
    const { createMockStore } = await import("../../helpers/mock-store.js");
    const { registerCommands } = await import("../../../src/commands/commands.js");
    const store = createMockStore();
    const commands = registerCommands(store);
    const text = () => store.getState().lines.map((l) => plain(l.text)).join("\n");
    return { store, commands, text };
  }

  it("/ps lists and /logs prints a process's output", async () => {
    const { store, commands, text } = await cmds();
    const id = store.getState().addProcess({ cmd: "npm test", pid: 0 });
    store.getState().appendProcessOutput(id, "3 passed");
    await commands["/ps"]();
    await commands["/logs"](String(id));
    expect(text()).toContain(`[bg ${id}]`);
    expect(text()).toContain("3 passed");
  });

  it("/kill all stops every running process", async () => {
    const { store, commands, text } = await cmds();
    store.getState().addProcess({ cmd: "a", pid: 0 });
    store.getState().addProcess({ cmd: "b", pid: 0 });
    await commands["/kill"]("all");
    expect(store.getState().processes.every((p) => p.status !== "running")).toBe(true);
    expect(text()).toContain("Stopped");
  });
});

describe("approval prompt", () => {
  async function withPending() {
    const { App } = await import("../../../src/components/App.js");
    const { createMockStore } = await import("../../helpers/mock-store.js");
    const store = createMockStore();
    store.setState({ pendingConfirmation: { toolName: "run_command", argsText: "ping -n 15 127.0.0.1", resolve() {} } });
    const onSubmit = vi.fn();
    const r = render(h(App, { store, onSubmit, onAbort() {}, onQuit() {} }));
    await tick();
    return { ...r, store, onSubmit };
  }

  it("is shown in the live zone with the command", async () => {
    const { lastFrame, unmount } = await withPending();
    const frame = plain(lastFrame());
    // Keys on the first row, the whole command under it.
    expect(frame).toContain("? run_command    [y] yes  [n] no  [a] always");
    expect(frame).toContain("\n    ping -n 15 127.0.0.1");
    unmount();
  });

  it("is answered with one key, which is not typed into the input", async () => {
    const { stdin, onSubmit, store, lastFrame, unmount } = await withPending();
    stdin.write("y");
    await tick();
    expect(onSubmit).toHaveBeenCalledWith("y");
    store.setState({ pendingConfirmation: null });
    await tick();
    expect(plain(lastFrame())).toMatch(/>\s*\n/);
    unmount();
  });

  it("treats Esc as no", async () => {
    const { stdin, onSubmit, unmount } = await withPending();
    stdin.write("\x1b");
    await tick();
    expect(onSubmit).toHaveBeenCalledWith("n");
    unmount();
  });
});

describe("a killed process", () => {
  it("stays killed when it then exits non-zero", async () => {
    const { createMockStore } = await import("../../helpers/mock-store.js");
    const store = createMockStore();
    const id = store.getState().addProcess({ cmd: "ping", pid: 0 });
    // What /kill does to the record, then the close handler with taskkill's 1.
    store.setState({ processes: store.getState().processes.map((p) => (p.id === id ? { ...p, status: "killed" } : p)) });
    store.getState().finishProcess(id, 1);
    expect(store.getState().processes[0].status).toBe("killed");
  });
});

describe("activity in the footer", () => {
  it("leads the status line while Flint works; no tool, so no row above the input", async () => {
    const { store, lastFrame, unmount } = await mount((s) => {
      s.getState().setAgentStatus("thinking");
      s.getState().setActivity({ kind: "call", label: "waiting for the model" });
    });
    await tick();
    const lines = plain(lastFrame()).split("\n").filter((l) => l.trim());
    const footer = lines[lines.length - 1];
    expect(footer).toMatch(/^ [⠚⠓⠋⠙] thinking\s+00:0\d/);
    expect(footer).toContain("│ $0.0000"); // the session facts follow the block
    // Nothing but the rule sits above the input.
    const inputIdx = lines.findIndex((l) => l.startsWith(">"));
    expect(lines.slice(0, inputIdx).every((l) => /^-+$/.test(l))).toBe(true);
    unmount();
  });
});

describe("a process stopped by Esc", () => {
  it("is one ledger line that says what is still running", async () => {
    const { createMockStore } = await import("../../helpers/mock-store.js");
    const { initOutput, printProcessEnd } = await import("../../../src/ui/output.js");
    const store = createMockStore();
    initOutput(store);
    store.getState().addProcess({ cmd: "ping -n 300 127.0.0.1", pid: 0 });
    const id = store.getState().addProcess({ cmd: "ping -n 302 127.0.0.1", pid: 0 });
    store.setState({ processes: store.getState().processes.map((p) => (p.id === id ? { ...p, status: "killed" } : p)) });
    const cols = process.stdout.columns;
    process.stdout.columns = 130;
    try { printProcessEnd(id, "ping -n 302 127.0.0.1", 1, "2m 54s", "killed"); } finally { process.stdout.columns = cols; }
    const lines = store.getState().lines.map((l) => plain(l.text));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/sh\s+killed\s+ping -n 302 127\.0\.0\.1\s+bg 2\s+2m 54s  · 1 still running, Esc stops the newest/);
  });
});

describe("Ctrl+C with background processes", () => {
  it("warns once before exiting, then exits on the next press", async () => {
    const { stdin, onQuit, all, unmount } = await mount((s) => s.getState().addProcess({ cmd: "npm run dev", pid: 0 }));
    stdin.write("\x03"); await tick();
    stdin.write("\x03"); await tick();
    expect(onQuit).not.toHaveBeenCalled();
    expect(all()).toContain("1 background process still running. Ctrl+C again to stop it and exit.");
    stdin.write("\x03"); await tick();
    expect(onQuit).toHaveBeenCalledTimes(1);
    unmount();
  });
});
