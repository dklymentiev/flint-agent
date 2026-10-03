// Writes into the operating system's own folders are refused at every policy
// (2026-10-02). GitHub's Windows runner runs as administrator, and Flint wrote
// a file into C:\Windows\System32: only the OS had ever said no, and at the
// normal care level file writes do not ask. Reads stay allowed.
import { describe, it, expect } from "vitest";
import { createPathGuardHook } from "../../../src/security/path-guard.js";
import { loadPolicy } from "../../../src/security/policies.js";

const win = process.platform === "win32";
const sys = win ? "C:\\Windows\\System32\\flint-probe.txt" : "/etc/flint-probe.conf";
const sysOtherCase = win ? "c:\\WINDOWS\\system32\\flint-probe.txt" : "/usr/local/bin/flint-probe";
const programs = win ? "C:\\Program Files\\Flint\\x.txt" : "/boot/flint-probe";

describe("operating system folders", () => {
  for (const level of ["strict", "normal", "permissive"]) {
    it(`refuses writes there under the ${level} policy`, () => {
      const hook = createPathGuardHook(loadPolicy({ securityPolicy: level }));
      for (const p of [sys, sysOtherCase, programs]) {
        const r = hook("write_file", { path: p, content: "x" });
        expect(r?.deny, `write to ${p} was not refused`).toBe(true);
      }
      expect(hook("delete_file", { path: sys })?.deny).toBe(true);
      expect(hook("move_file", { source: "a.txt", destination: sys })?.deny).toBe(true);
    });
  }

  it("still lets Flint read there", () => {
    const hook = createPathGuardHook(loadPolicy({ securityPolicy: "normal" }));
    expect(hook("read_file", { path: sys })?.deny).not.toBe(true);
  });

  it("does not touch ordinary folders", () => {
    const hook = createPathGuardHook(loadPolicy({ securityPolicy: "normal" }));
    const ordinary = win ? "C:\\Users\\someone\\project\\Windows\\notes.txt" : "/home/someone/etc/notes.txt";
    expect(hook("write_file", { path: ordinary, content: "x" })).toBe(null);
  });
});
