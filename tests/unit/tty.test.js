import { describe, it, expect, vi } from "vitest";
import { PassThrough } from "node:stream";
import { fakeStdinTTY, stdinIsRealTTY, noTerminalSetupRefusal, watchForEmptyInput } from "../../src/tty.js";

describe("stdinIsRealTTY", () => {
  it("is true for a terminal", () => {
    expect(stdinIsRealTTY({ isTTY: true })).toBe(true);
  });
  it("is false for a pipe", () => {
    expect(stdinIsRealTTY({ isTTY: undefined })).toBe(false);
  });
  it("sees through the stand-in terminal index.js gives ink", () => {
    const s = new PassThrough();
    fakeStdinTTY(s);
    expect(s.isTTY).toBe(true);
    expect(stdinIsRealTTY(s)).toBe(false);
    expect(typeof s.setRawMode).toBe("function");
  });
});

describe("noTerminalSetupRefusal", () => {
  it("names what is missing and how to set it, in one line", () => {
    const m = noTerminalSetupRefusal({ action: "new" }, true, false);
    expect(m).toMatch(/OPENROUTER_API_KEY/);
    expect(m).toMatch(/--model/);
    expect(m).not.toMatch(/\n/);
  });
  it("lets a terminal run the wizard", () => {
    expect(noTerminalSetupRefusal({ action: "new" }, true, true)).toBeNull();
  });
  it("says nothing when a key exists", () => {
    expect(noTerminalSetupRefusal({ action: "new" }, false, false)).toBeNull();
  });
  it("leaves list, check and stdio to their own handling", () => {
    for (const action of ["list", "check", "stdio"]) {
      expect(noTerminalSetupRefusal({ action }, true, false)).toBeNull();
    }
  });
});

describe("watchForEmptyInput", () => {
  it("fires when the input ends having delivered nothing", () => {
    const s = new PassThrough();
    const onEmpty = vi.fn();
    watchForEmptyInput({ stdin: s, onEmpty });
    s.emit("end");
    s.emit("close");
    expect(onEmpty).toHaveBeenCalledTimes(1);
  });
  it("does not fire when input arrived", () => {
    const s = new PassThrough();
    s.bytesRead = 5;
    const onEmpty = vi.fn();
    watchForEmptyInput({ stdin: s, onEmpty });
    s.emit("end");
    expect(onEmpty).not.toHaveBeenCalled();
  });
});
