// The prompt must tell the truth about how long it will wait.
//
// Criterion 6. The two halves of the confirmation had drifted apart:
//
//   src/tools/permissions.js   confirmTimeoutMs = 600000        (10 minutes)
//   src/ui/output.js:375       "30s timeout -> deny"            (30 seconds)
//
// The 30 s is the number from before the timeout was raised. It was raised on
// purpose, because a prompt that timed out after half a minute sent every
// denied tool straight back to the model, which retried, which timed out again
// — a retry-storm against a human who was reading the screen. So the real
// behaviour is 600 s and the string the operator reads is wrong by a factor of
// twenty.
//
// Which of the two is the bug matters, and the answer is not "make them
// equal": the 600 s is deliberate, so the number on screen is what has to
// change. Reverting to 30 s would reintroduce the storm.
//
// The other half of the fix is structural. A test that hardcodes "30s" and a
// constant that says 600000 are two facts in two files, and the only thing
// keeping them together is that someone remembered. If the UI reads the number
// from the module that decides it, they cannot drift again — so the test below
// checks where the number comes from, not merely what it currently says.
//
// The same reasoning covers the other prompt in output.js, which has its own
// "30s timeout -> deny" line for the file-edit confirmation.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";

import { initPermissions, getConfirmTimeoutMs } from "../../../src/tools/permissions.js";

let outputSrc;

beforeEach(async () => {
  outputSrc = await import("fs").then((fs_) => fs_.readFileSync("src/ui/output.js", "utf-8"));
});

describe("the confirmation prompt states the real timeout", () => {
  it("reports the timeout the confirmation actually uses", () => {
    initPermissions({ confirm: async () => true, timeout: 600000 });
    expect(getConfirmTimeoutMs()).toBe(600000);
  });

  // 2026-10-01: the question moved out of history into the live zone and no
  // longer prints a timeout at all (owner: too much noise). What must still
  // hold is that the UI and permissions.js agree on the window: bootstrap takes
  // the question off the screen after getConfirmTimeoutMs(), the same moment
  // permissions.js gives up.
  it("takes the question off the screen after the real timeout", () => {
    const boot = fs.readFileSync("src/bootstrap.js", "utf-8");
    expect(boot).toContain('setTimeout(() => wrappedResolve("timeout"), getConfirmTimeoutMs())');
  });

  it("has no hardcoded timeout in the confirmation text", () => {
    const hardcoded = outputSrc.match(/\b\d+s timeout/g) || [];
    expect(hardcoded).toHaveLength(0);
  });
});
