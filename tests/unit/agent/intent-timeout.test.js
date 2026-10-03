// The classifier's per-attempt budget is a setting, not a constant buried in a
// request body, and a bad value fails loudly.
//
// This came out of item 10: operator-visibility.test.js failed on a loaded
// machine, and one of the causes was a hard 15 s wall-clock deadline in the
// classifier call that no caller could see or control. It is now readable from
// INTENT_TIMEOUT_MS.
//
// The project rule is no silent fallbacks: a required value that is absent
// throws at config load rather than quietly becoming a default. An override
// gets the same treatment. A caller that sets INTENT_TIMEOUT_MS=0 and silently
// receives 15 s has the original problem in a new place — a budget that is not
// what was asked for, with nothing said.
//
// Tested against the exported function rather than through classifyIntent,
// deliberately. Driving the real classifier to observe the number meant
// waiting on a network call, a spend gate and a fallback path that swallows
// its own errors, and the value could only be read by letting a call fail. That
// is a test whose result depends on timing — the very thing item 10 is about.
// The setting is a pure function of the environment, and a pure function is
// tested directly.

import { describe, it, expect, afterEach } from "vitest";
import { intentTimeoutMs } from "../../../src/agent/intent-timeout.js";

afterEach(() => { delete process.env.INTENT_TIMEOUT_MS; });

describe("the classifier budget", () => {
  it("defaults to 15 s, which is the production behaviour, unchanged", () => {
    delete process.env.INTENT_TIMEOUT_MS;
    expect(intentTimeoutMs()).toBe(15000);
  });

  it("uses the budget it was given", () => {
    process.env.INTENT_TIMEOUT_MS = "60000";
    expect(intentTimeoutMs()).toBe(60000);
  });

  it("a larger budget is not clamped back down", () => {
    // The point of the setting: a caller that knows it has room can say so.
    process.env.INTENT_TIMEOUT_MS = "90000";
    expect(intentTimeoutMs()).toBe(90000);
  });

  it("accepts a short budget for a caller that wants to fail fast", () => {
    process.env.INTENT_TIMEOUT_MS = "2000";
    expect(intentTimeoutMs()).toBe(2000);
  });

  it("refuses a value that is not a positive number, rather than using 15 s", () => {
    for (const bad of ["0", "-1", "abc", "NaN", " "]) {
      process.env.INTENT_TIMEOUT_MS = bad;
      expect(() => intentTimeoutMs(), `INTENT_TIMEOUT_MS=${JSON.stringify(bad)}`).toThrow(/INTENT_TIMEOUT_MS/);
    }
  });

  it("reports the offending value, so the mistake is obvious from the message", () => {
    process.env.INTENT_TIMEOUT_MS = "0";
    expect(() => intentTimeoutMs()).toThrow(/positive number of milliseconds/);
    expect(() => intentTimeoutMs()).toThrow(/got: 0/);
  });

  it("treats an empty value as unset, because that is what an empty env var is", () => {
    // An empty string is a real thing to find in a .env, and it means "not
    // set" rather than "zero". Calling it unset is the one place a fallback is
    // right, and it is not silent: unset means the documented default.
    process.env.INTENT_TIMEOUT_MS = "";
    expect(intentTimeoutMs()).toBe(15000);
  });
});
