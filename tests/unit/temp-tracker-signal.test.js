// src/temp-tracker.js and the other listeners of the same signal.
//
// Node calls every listener of a signal once per delivery. The tracker used to
// clean up and then send the signal to the process again, so that the default
// action would end it. With Flint's own shutdown listener registered, that
// second delivery ran the shutdown a second time. The tracker now re-sends
// only when it was the last listener; otherwise the listeners that are there
// have already been called by this delivery and own the exit.
//
// No signal is sent here: the handler the tracker registers is captured and
// called directly, so this runs on Windows too. What a real signal does to a
// real process is tests/integration/temp-cleanup-signal.test.js (Linux/macOS).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let registered;      // signal -> the tracker's handler
let kill;
let dir;

async function loadTracker() {
  vi.resetModules();
  registered = {};
  const realOn = process.on.bind(process);
  vi.spyOn(process, "on").mockImplementation((event, fn) => {
    if (event === "SIGTERM" || event === "SIGINT") { registered[event] = fn; return process; }
    if (event === "exit") return process; // not left on the test worker
    return realOn(event, fn);
  });
  // The tracker removes its own listener; it was never really added.
  vi.spyOn(process, "removeListener").mockImplementation(() => process);
  kill = vi.spyOn(process, "kill").mockImplementation(() => true);
  return import("../../src/temp-tracker.js");
}

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "flint-tt-")); });
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("temp-tracker signal handler", () => {
  it("with another listener on the signal: cleans up and does not deliver the signal again", async () => {
    const tracker = await loadTracker();
    tracker.trackTempDir(dir);
    // Flint's own shutdown listener (index.js) is there as well.
    vi.spyOn(process, "listenerCount").mockImplementation((sig) => (sig === "SIGTERM" ? 1 : 0));

    registered.SIGTERM();

    expect(fs.existsSync(dir), "tracked dir is removed").toBe(false);
    expect(kill, "the signal must not be sent a second time").not.toHaveBeenCalled();
  });

  it("as the only listener: cleans up and re-sends, so the default action ends the process", async () => {
    const tracker = await loadTracker();
    tracker.trackTempDir(dir);
    vi.spyOn(process, "listenerCount").mockImplementation(() => 0);

    registered.SIGTERM();

    expect(fs.existsSync(dir)).toBe(false);
    expect(kill).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith(process.pid, "SIGTERM");
  });

  it("called a second time it does nothing", async () => {
    const tracker = await loadTracker();
    tracker.trackTempDir(dir);
    vi.spyOn(process, "listenerCount").mockImplementation(() => 0);

    registered.SIGTERM();
    registered.SIGTERM();
    registered.SIGINT();

    expect(kill).toHaveBeenCalledTimes(1);
  });
});
