// What the first run actually shows the operator.
//
// Owner, 2026-09-30: the first-run question was one
// readline line — a heading, three bracketed options run together and "pick s,
// n or p" — and the owner read it as a wall of text and did not know what was
// being asked.
//
// tests/unit/components/careful-menu.test.js renders CarefulMenu through real
// ink, presses keys on it and reads the frames it draws — that is where the
// pixels, the colour and the arrow-key behaviour are proven.
//
// This file is here for the other half, which nothing else covered: whether
// startup mounts that menu at all. The menu was written and passed eleven
// component tests while bootstrap still called askOnboardingIfNeeded with the
// readline question, so a green unit suite said nothing at all about what a
// first run looked like. That is the same failure shape as 2f6824c's Tab fix,
// whose test only read the source text of the Tab branch.
//
// So this drives initOnboarding — the function startup actually calls — and
// asserts on what it hands to ink and what it records.
//
// ink's render is stubbed rather than run for real: ink 6.8.0 builds a
// Console when it patches the terminal, which throws under vitest's replaced
// console ("console.Console is not a constructor"), and a test that renders for
// real here would be testing vitest as much as the menu. Everything about how
// the menu draws belongs in the unit suite, which drives the real component.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../src/logging/logger.js", () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}));

const renders = vi.hoisted(() => ({ calls: [] }));

vi.mock("ink", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    render: (element, options) => {
      const call = { element, options, unmounted: false };
      // Settles only when the menu is unmounted, so a bootstrap that renders
      // and then forgets to hand the terminal back hangs here instead of
      // quietly passing.
      let resolveExit;
      const exited = new Promise((r) => { resolveExit = r; });
      call.unmount = () => { call.unmounted = true; resolveExit(); };
      renders.calls.push(call);
      return {
        waitUntilExit: () => exited,
        unmount: call.unmount,
        rerender: () => {},
        clear: () => {},
      };
    },
  };
});

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

function withTTY(on) {
  const original = process.stdin.isTTY;
  Object.defineProperty(process.stdin, "isTTY", { value: on, configurable: true });
  return () => Object.defineProperty(process.stdin, "isTTY", { value: original, configurable: true });
}

async function freshPermissions() {
  const perms = await import("../../src/tools/permissions.js");
  perms.resetPermissionState();
  perms.resetSessionOverrides();
  return perms;
}

describe("first run: the question is a menu, not a wall of text", () => {
  let restoreTTY;

  beforeEach(() => {
    renders.calls.length = 0;
  });

  afterEach(() => {
    restoreTTY?.();
    restoreTTY = undefined;
  });

  it("mounts the CarefulMenu — the component, not the readline question", async () => {
    const perms = await freshPermissions();
    restoreTTY = withTTY(true);
    const { CarefulMenu } = await import("../../src/components/CarefulMenu.js");

    const { initOnboarding } = await import("../../src/bootstrap.js");
    const done = initOnboarding();
    await tick();

    expect(renders.calls, "initOnboarding rendered nothing at all").toHaveLength(1);
    const call = renders.calls[0];
    // Identity, not a name: a wrapper that swallowed the menu would pass a
    // string check and still show the operator the old question.
    expect(call.element.type).toBe(CarefulMenu);
    expect(typeof call.element.props.onSelect, "the menu was mounted with nothing to tell").toBe("function");
    expect(typeof call.element.props.onCancel, "the menu cannot be declined").toBe("function");

    call.unmount();
    await done.catch(() => {});
    perms.resetSessionOverrides();
  });

  it("asks the menu a real question and saves what it answers", async () => {
    const perms = await freshPermissions();
    restoreTTY = withTTY(true);

    const { initOnboarding } = await import("../../src/bootstrap.js");
    const done = initOnboarding();
    await tick();

    // What CarefulMenu does when the operator presses Enter on "safe".
    renders.calls[0].element.props.onSelect("safe");
    await done;

    expect(perms.getOnboardingAnswer(), "the chosen level was not recorded").toBe("safe");
    expect(perms.getOnboardingState().asked, "the answer was not persisted").toBe(true);

    perms.resetSessionOverrides();
  });

  it("refuses a level the menu should never be able to offer", async () => {
    const perms = await freshPermissions();
    restoreTTY = withTTY(true);

    const { initOnboarding } = await import("../../src/bootstrap.js");
    const done = initOnboarding();
    await tick();

    // Defence in depth: CarefulMenu can only offer LEVELS, but the thing that
    // persists is askOnboardingIfNeeded, so that is where it has to be enforced.
    renders.calls[0].element.props.onSelect("yolo");
    await done;

    expect(perms.getOnboardingAnswer(), "a posture nobody chose was recorded").toBeNull();
    expect(perms.getOnboardingState().asked, "an invalid answer was persisted").toBe(false);

    perms.resetSessionOverrides();
  });

  it("Esc saves nothing — a cancelled question is not an answer", async () => {
    const perms = await freshPermissions();
    restoreTTY = withTTY(true);

    const { initOnboarding } = await import("../../src/bootstrap.js");
    const done = initOnboarding();
    await tick();

    renders.calls[0].element.props.onCancel();
    await done;

    expect(perms.getOnboardingAnswer(), "Esc recorded a level nobody chose").toBeNull();
    expect(perms.getOnboardingState().asked, "Esc marked the question as answered").toBe(false);

    perms.resetSessionOverrides();
  });

  it("gives the terminal back once answered", async () => {
    const perms = await freshPermissions();
    restoreTTY = withTTY(true);

    const { initOnboarding } = await import("../../src/bootstrap.js");
    const done = initOnboarding();
    await tick();

    const call = renders.calls[0];
    expect(call.unmounted, "the menu was already gone before it was answered").toBe(false);

    call.element.props.onSelect("normal");
    await done;

    // Left mounted, this ink instance and the session's own (index.js) would
    // both read the same terminal and split every keystroke between them.
    expect(call.unmounted, "the menu still holds the keyboard after it was answered").toBe(true);

    perms.resetSessionOverrides();
  });

  it("does not ask at all when stdin is not a TTY — the documented default applies", async () => {
    const perms = await freshPermissions();
    restoreTTY = withTTY(false);

    const { initOnboarding } = await import("../../src/bootstrap.js");
    await initOnboarding();

    expect(renders.calls.length, "the menu was rendered on a non-TTY stdin").toBe(0);
    expect(perms.getOnboardingState().asked, "a non-TTY run recorded an answer").toBe(false);
  });

  it("does not draw over a session start that was already answered", async () => {
    const perms = await freshPermissions();
    perms.saveOnboardingAnswer("safe");
    restoreTTY = withTTY(true);

    const { initOnboarding } = await import("../../src/bootstrap.js");
    await initOnboarding();

    expect(renders.calls.length, "the menu was drawn over a normal session start").toBe(0);

    perms.resetSessionOverrides();
  });
});
