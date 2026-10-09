// A --headless run must never show the first-run
// question, whatever stdin is, and nothing may be written as if the operator
// had answered it.
//
// Two launches were lost to this. Started under sudo — where the process still
// holds a pseudoterminal — a clean home directory showed "How careful should
// Flint be?" and the run waited for a key forever, under the --headless flag.
// initOnboarding gated on process.stdin.isTTY only, and a pseudoterminal is a
// TTY. whileWaitingForOperator lifted the startup watchdog while it waited, so
// nothing timed out either.
//
// The operator reported seeing the menu once with stdin from /dev/null as well.
// That case has no log and I did not reproduce it, so nothing here claims to
// cover it; the headless check below makes the whole question unreachable in
// that run regardless of what stdin is.
//
// ink's render is captured the same way onboarding-menu.test.js does it: real
// initOnboarding, stubbed render, so what is asserted is that startup mounts
// the menu at all — not how the menu looks.
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "headless-onboard-"));

afterAll(() => {
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

vi.mock("../../src/logging/logger.js", () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}));

const renders = vi.hoisted(() => ({ calls: [] }));

// Without this mock config.projectRoot is the real repository, so every run of
// this file shares one .permissions.json with the rest of the suite. The
// onboarding answer persisted between tests, the first run was already marked
// as asked, and "still asks a person sitting at the keyboard" saw no menu —
// which is why this file passed alone and failed in a full run. Measured, not
// assumed: resetPermissionState() does clear the flag, and resetSessionOverrides()
// does not, because it skips ONBOARDING_KEY on purpose (permissions.js:465).
const onbTmp = vi.hoisted(() => {
  const os = require("node:os");
  const path = require("node:path");
  const fs = require("node:fs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "headless-onboard-"));
  return dir;
});

vi.mock("../../src/config.js", () => ({
  config: { projectRoot: onbTmp, sessionsDir: path.join(onbTmp, "sessions") },
}));

vi.mock("ink", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    render: (element, options) => {
      const call = { element, options, unmounted: false };
      let resolveExit;
      const exited = new Promise((r) => { resolveExit = r; });
      call.unmount = () => { call.unmounted = true; resolveExit(); };
      renders.calls.push(call);
      return { waitUntilExit: () => exited, unmount: call.unmount, rerender: () => {}, clear: () => {} };
    },
  };
});

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait until ink.render() has actually been called, or give up.
 *
 * A fixed sleep was the cause of a real flake: askCarefulLevel() awaits three
 * dynamic imports (ink, CarefulMenu, react — bootstrap.js:173) before it
 * renders, and on a loaded machine that takes longer than the 20 ms the test
 * allowed. The assertion then read zero renders and reported that the first-run
 * menu had disappeared, which is not what had happened.
 */
async function waitForRender(timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (renders.calls.length === 0 && Date.now() < deadline) {
    await tick(10);
  }
  await tick(0);
}

function withTTY(on) {
  const original = process.stdin.isTTY;
  Object.defineProperty(process.stdin, "isTTY", { value: on, configurable: true });
  return () => Object.defineProperty(process.stdin, "isTTY", { value: original, configurable: true });
}

async function load({ headless, tty }) {
  // Delete the persisted answer BEFORE the modules load. permissions.js reads
  // .permissions.json at import time and caches it, so removing the file after
  // the import leaves the old value in place — which is what made this test
  // pass alone and fail in a full run, and then fail on the third of three
  // consecutive runs. ONBOARDING_KEY is skipped by resetSessionOverrides() on
  // purpose (permissions.js:465), so the file is the only lever.
  fs.rmSync(path.join(onbTmp, ".permissions.json"), { force: true });
  vi.resetModules();
  renders.calls.length = 0;
  const restore = withTTY(tty);
  const perms = await import("../../src/tools/permissions.js");
  // resetPermissionState() (permissions.js:186) deletes every key in
  // sessionOverrides, ONBOARDING_KEY included, which is what makes the
  // first-run question reachable again. resetSessionOverrides() must not be
  // used here — it skips that key on purpose so the care level survives a
  // permissions reset, and with it the "already asked" flag. That residue is
  // what left the interactive case with no menu in the second of three runs.
  perms.resetPermissionState();
  const { config } = await import("../../src/config.js");
  // Not config.headless = true: this test used to set the flag itself, which is
  // the same mistake as restating index.js's block — it proved the copy, not
  // the path. The real flag is set by markHeadless(cli) at index.js:114, which
  // runs BEFORE the wizard (126) and bootstrap() (185). Driving markHeadless
  // here exercises that same call instead of standing in for it.
  const { markHeadless } = await import("../../src/headless-start.js");
  if (headless) {
    markHeadless({ action: "headless" });
  } else {
    // config is a cached module: without this the interactive case inherits
    // config.headless = true from an earlier test in this file and never sees
    // the menu. That is the test's bug, not the code's — a console run never
    // goes through markHeadless at all.
    config.headless = false;
  }
  const { initOnboarding } = await import("../../src/bootstrap.js");
  return { perms, initOnboarding, restore, config, markHeadless };
}

describe("--headless must never ask the first-run question", () => {
  let restore;

  beforeEach(() => { vi.resetModules(); });
  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  it("does not mount the menu on a TTY, as under sudo", async () => {
    const loaded = await load({ headless: true, tty: true });
    restore = loaded.restore;

    await loaded.initOnboarding();
    await tick();

    expect(renders.calls, "the first-run menu was rendered on a headless run")
      .toHaveLength(0);
  });

  it("writes nothing that would look like an answer", async () => {
    const loaded = await load({ headless: true, tty: true });
    restore = loaded.restore;

    await loaded.initOnboarding();
    await tick();

    // The direction that matters: a level nobody chose is never recorded, so
    // the question is still there for the operator's next interactive start.
    expect(loaded.perms.getOnboardingAnswer(), "an answer was written for the operator").toBeNull();
    expect(loaded.perms.getOnboardingState().asked, "the question was marked as answered").toBe(false);
  });

  it("is unreachable regardless of stdin", async () => {
    for (const tty of [true, false, undefined]) {
      const loaded = await load({ headless: true, tty });
      loaded.restore();
      renders.calls.length = 0;

      await loaded.initOnboarding();
      await tick();

      expect(renders.calls, `the menu appeared with stdin.isTTY=${tty}`).toHaveLength(0);
    }
  });

  it("still asks a person sitting at the keyboard", async () => {
    const loaded = await load({ headless: false, tty: true });
    restore = loaded.restore;

    const done = loaded.initOnboarding();
    await waitForRender();

    // Guarding the wrong way would silently kill the first run for everyone.
    expect(renders.calls, "an interactive start no longer asks the question")
      .toHaveLength(1);

    renders.calls[0].unmount();
    await done.catch(() => {});
    loaded.perms.resetSessionOverrides();
  });
});