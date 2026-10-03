// The self-verification gate is off unless the operator turns it on.
// Measured 2026-09-29: on mimo it cost a round in 34 of 43 benchmark tasks
// with no gain in passes.
import { describe, it, expect, vi } from "vitest";

describe("config.selfVerify", () => {
  it("is off when FLINT_SELF_VERIFY is not set, on only for 'on'", async () => {
    const saved = process.env.FLINT_SELF_VERIFY;
    try {
      delete process.env.FLINT_SELF_VERIFY;
      vi.resetModules();
      expect((await import("../../src/config.js")).config.selfVerify).toBe("off");
      process.env.FLINT_SELF_VERIFY = "on";
      vi.resetModules();
      expect((await import("../../src/config.js")).config.selfVerify).toBe("on");
    } finally {
      if (saved === undefined) delete process.env.FLINT_SELF_VERIFY;
      else process.env.FLINT_SELF_VERIFY = saved;
      vi.resetModules();
    }
  });
});
