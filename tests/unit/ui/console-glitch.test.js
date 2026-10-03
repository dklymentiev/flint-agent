// Two console glitches, and one message that stopped being true. (item 7)
//
// 7.1  "the start banner and the first commands print four times"
// 7.2  "after switching tabs, selecting text to copy makes the screen scroll
//       wildly"
//
// Plus the Esc behaviour itself: it was the step, ten presses of it restarted
// one step ten times, and the operator meant "stop". Esc ends the agent task
// and keeps the queue. "stop" still discards the queue, so it still exists.

import { describe, it, expect, beforeAll } from "vitest";
import { createMockStore } from "../../helpers/mock-store.js";

let launcherSrc, appSrc, indexSrc;

// Read once: these are assertions about what the source does, and a test that
// re-read per test would be slower for no gain.
beforeAll(async () => {
  const fs = await import("fs");
  launcherSrc = fs.readFileSync("src/launcher.js", "utf-8");
  appSrc = fs.readFileSync("src/components/App.js", "utf-8");
  indexSrc = fs.readFileSync("src/index.js", "utf-8");
});

/** The Tab branch of the input handler, not the whole file. */
function tabBranch() {
  // Anchored on a comment that is unique to this branch. The earlier version
  // of this test searched for the identifier `handleTab`, which does not exist
  // — the handler is inline in useKeyboard — so indexOf returned -1, the slice
  // came back empty, and two assertions passed against an empty string.
  const start = appSrc.indexOf("// Tab — cycle tabs");
  expect(start, "the Tab branch was not found; update this anchor").toBeGreaterThan(-1);
  // Up to the next key branch, not a fixed 1200 characters: a longer comment
  // in the branch pushed its last lines past a fixed cut and failed the test
  // for a change that did not touch them.
  const end = appSrc.indexOf("if (key.upArrow)", start);
  expect(end, "the end of the Tab branch was not found; update this anchor").toBeGreaterThan(start);
  return appSrc.slice(start, end);
}

/**
 * Source with its comments removed.
 *
 * Needed because these fixes explain the old code by name: the tab branch says
 * it "used to defer the switch through setTimeout(…, 0)". A search for
 * `setTimeout` that does not strip comments finds that explanation and fails
 * forever — the test would insist the timer is gone while the file is
 * explaining why it went.
 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("7.1 the start banner prints once", () => {
  it("stops the splash spinner on the child's first output, not on a timer", () => {
    // The banner was printed four times because the launcher's spinner
    // repainted with a bare \r every 200 ms for a fixed 500 ms after spawn.
    // \r is "back to column 0 of whatever line is current now" — once the
    // child is drawing, that is the child's line, so every tick reprinted
    // FLINT AGENT on top of the child's own banner.
    const fixedTimer = /setTimeout\(\s*\(\)\s*=>\s*clearInterval\(_spinner\)\s*,\s*\d+\s*\)/;
    expect(launcherSrc).not.toMatch(fixedTimer);
  });

  it("releases the terminal when the child says it has drawn", () => {
    // The child is spawned with the three standard streams inherited, so there
    // is no pipe to watch — child.stdout and child.stderr are both null, which
    // an earlier attempt at this fix discovered the hard way by attaching to
    // them and doing nothing. The child announces itself over IPC instead.
    expect(launcherSrc).toMatch(/"ipc"/);
    expect(launcherSrc).toMatch(/child\.on\(\s*["']message["'][\s\S]{0,160}releaseTerminal\(\)/);
  });

  it("the child announces itself only when there is a channel to use", () => {
    // Started directly — `node src/index.js`, tests, headless — there is no
    // parent IPC and process.send is undefined. That is a normal way to run
    // Flint and must not throw at startup.
    expect(indexSrc).toMatch(/if \(process\.send\)/);
    expect(indexSrc).toMatch(/process\.send\(\{\s*type:\s*["']flint:ready["']/);
  });

  it("stops the spinner before the child clears the screen, not after it draws", () => {
    // Owner, 2026-10-02: "loading..." sometimes sat on the top line of the
    // console with Ink's border drawn after it. flint:ready went out after the
    // first render, so a tick between the clear and the message wrote into
    // the cleared screen. The child now asks first, waits for the launcher's
    // answer, then clears; the launcher stops the interval before answering.
    const ask = indexSrc.indexOf('process.send({ type: "flint:ready" })');
    const wait = indexSrc.indexOf('"flint:released"', indexSrc.indexOf("await new Promise"));
    const clear = indexSrc.indexOf('process.stdout.write("\\x1b[2J');
    expect(ask).toBeGreaterThan(-1);
    expect(wait).toBeGreaterThan(-1);
    expect(clear).toBeGreaterThan(Math.max(ask, wait));
    expect(launcherSrc).toMatch(/releaseTerminal\(\);\s*\n\s*try \{ child\.send\(\{ type: "flint:released" \}\)/);
  });

  it("keeps the standard streams inherited, so Ink keeps the TTY", () => {
    // Piping stdout/stderr would cost Ink raw-mode key handling. The fix adds a
    // fourth channel; it must not rearrange the first three.
    expect(launcherSrc).toMatch(/stdio:\s*\[\s*["']inherit["']\s*,\s*["']inherit["']\s*,\s*["']inherit["']\s*,\s*["']ipc["']\s*\]/);
  });

  it("still stops the spinner if the child dies before it ever says anything", () => {
    // A child that exits without announcing must not leave the interval
    // holding the event loop open.
    expect(launcherSrc).toMatch(/child\.on\(\s*["']error["']\s*,\s*releaseTerminal\s*\)/);
    expect(launcherSrc).toMatch(/child\.on\(\s*["']exit["'][\s\S]{0,120}releaseTerminal\(\)/);
  });

  it("releaseTerminal actually stops the interval", () => {
    // Guards against a refactor that empties the function body: the assertion
    // above would still find the wiring and the spinner would run forever.
    const body = launcherSrc.slice(
      launcherSrc.indexOf("function releaseTerminal"),
      launcherSrc.indexOf("function releaseTerminal") + 200,
    );
    expect(body).toMatch(/clearInterval\(_spinner\)/);
  });

  it("a tick after release writes nothing", () => {
    // The interval is kept as a ceiling, not removed. If it is left running it
    // must at least be silent, or it reintroduces the overwrite it was fixed
    // for.
    const spinner = launcherSrc.slice(launcherSrc.indexOf("_spinner = setInterval"), launcherSrc.indexOf("}, 200)"));
    expect(spinner).toMatch(/if \(_released\) return;/);
  });
});

describe("Esc ends the agent task and keeps the queue", () => {
  // Owner, 2026-09-30: one question, then ten presses of Esc to interrupt the
  // work. Ten "[Step stopped] lines" and the task ran on — Esc had been given
  // the step meaning, and the loop's own newStep() restarted the step each time.
  // A key that reports an interruption and produces none is worse than a dead
  // key. Esc is the task again; the queue is not, because discarding a message
  // typed mid-work is what this was fixed for.
  //
  // These are assertions on the store action Esc actually calls (escAbort),
  // not on the text of index.js. Source-shape tests passed after the mutation
  // that removed the whole-loop abort, because the comment explaining the fix
  // still contained the identifier the test searched for — the mistake the
  // tab-branch helper in this same file documents.
  /** handleAbort's body with comments removed, so prose cannot satisfy a code assertion. */
  function handleAbortSrc() {
    const start = indexSrc.indexOf("function handleAbort");
    expect(start, "handleAbort was not found; update this anchor").toBeGreaterThan(-1);
    const rest = indexSrc.slice(start);
    // Matched, not indexOf'd: this repo is CRLF on Windows and "\n}\n" finds
    // nothing there.
    const m = /\r?\n\}\r?\n/.exec(rest);
    expect(m, "the end of handleAbort was not found; update this anchor").toBeTruthy();
    return stripComments(rest.slice(0, m.index));
  }

  function loopWithStep() {
    const store = createMockStore();
    store.getState().registerTask({
      type: "agent-loop", label: "agent loop", abort: new AbortController(),
    });
    const step = new AbortController();
    store.getState().setStepAbort(step);
    return { store, step };
  }

  it("ends the task, not just the step", () => {
    const { store } = loopWithStep();
    const result = store.getState().escAbort();
    expect(result && result.type).toBe("agent-loop");
    // The loop's own controller is what "the task ended" means here: that is
    // the signal the agent loop checks and the API's /stop also fires.
    const loop = store.getState()._taskRegistry.find((t) => t.type === "agent-loop");
    expect(loop, "the task was removed from the registry, so it did not survive").toBeUndefined();
  });

  it("ends the model call in flight at once, not at the next loop boundary", () => {
    // A hung provider is exactly where an operator reaches for Esc, and the
    // loop only polls its step signal between iterations.
    const { store, step } = loopWithStep();
    store.getState().escAbort();
    expect(step.signal.aborted).toBe(true);
  });

  // Esc is the emergency brake (owner, 2026-10-01): the first press stops the
  // turn, every further press stops the newest background process, so
  // something started by accident can be stopped at once.
  it("stops the turn first, then background processes newest first", () => {
    const store = createMockStore();
    const killed = [];
    const now = Date.now();
    store.getState().registerTask({ type: "agent-loop", label: "agent loop", abort: new AbortController() });
    for (const [i, label] of ["old", "middle", "new"].entries()) {
      const id = store.getState().registerTask({ type: "bg-process", label, kill: () => killed.push(label) });
      // registerTask stamps ts; make the order explicit.
      store.setState({ _taskRegistry: store.getState()._taskRegistry.map((t) => (t.id === id ? { ...t, ts: now + i } : t)) });
    }
    expect(store.getState().escAbort().type).toBe("agent-loop");
    expect(killed).toEqual([]);
    expect(store.getState().escAbort().label).toBe("new");
    expect(store.getState().escAbort().label).toBe("middle");
    expect(store.getState().escAbort().label).toBe("old");
    expect(killed).toEqual(["new", "middle", "old"]);
    expect(store.getState().escAbort()).toBe(null);
  });

  it("says nothing when there is nothing to stop", () => {
    // A press that stopped nothing prints nothing, so Esc with nothing running
    // is silent rather than a line of noise per press.
    expect(createMockStore().getState().escAbort()).toBe(null);
  });

  it("does not flush the bus, so a message typed mid-work survives", () => {
    // The old failure: Esc ran abortNext() and then busFlush(), and flush()
    // failed every pending message as "flushed" 19 ms before the task died.
    // escAbort() reaches no bus at all, which is the property worth pinning.
    // Comments stripped first: the branch explains this exact rule in prose,
    // and a plain search finds its own explanation.
    expect(handleAbortSrc()).not.toMatch(/busFlush\(/);
  });

  it("says it stopped in one short line", () => {
    // 2026-10-01: the long "[Aborted: ... the queue is kept; anything you typed
    // is still coming]" with blank lines around it was noise (owner).
    expect(handleAbortSrc()).toContain("[stopped");
    expect(handleAbortSrc()).not.toMatch(/anything you typed is still coming/);
  });

  it("the word stop still exists as the way to discard the queue too", () => {
    // Esc keeps the queue. Something must clear it, and that is still `stop`.
    expect(indexSrc).toMatch(/lower === "stop"/);
  });
});
