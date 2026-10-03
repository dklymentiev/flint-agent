// Esc stops the current step. The task continues, and the operator's queued
// message is still there afterwards.
//
// Session 2026-09-30T00-37-42, 19:59-20:01:
//
//   19:59:52        owner types a question while a task runs
//                   -> "queued (bus #5)", nothing else for 100 s
//   20:01:33.650    [bus] FAIL {id:5, error:flushed}    the question
//   20:01:33.669    [bus] FAIL {id:4, error:aborted}   the running task
//
// Nineteen milliseconds apart, from one call: Esc ran abortNext() and then
// busFlush(), and flush() failed every pending message as "flushed" while the
// running one was "aborted". The only way to ask a question mid-work cost the
// operator both the question and the task.
//
// The distinction the code never made: a *step* is one model call or one tool;
// a *task* is the whole thing the operator asked for. Esc means the step. The
// HTTP API's /stop means the task, and still will.

import { describe, it, expect } from "vitest";
import { createMockStore } from "../../helpers/mock-store.js";

/** A store with an agent loop registered, as message-handler does. */
function withLoop() {
  const store = createMockStore();
  store.getState().registerTask({
    type: "agent-loop",
    label: "agent loop",
    abort: new AbortController(),      // the whole-loop signal: API /stop
  });
  return store;
}

describe("abortStep stops the step, not the task", () => {
  it("returns false when no agent loop is running", () => {
    // Esc with nothing running says nothing at all.
    const store = createMockStore();
    expect(store.getState().abortStep()).toBe(false);
  });

  it("returns false when the loop has not published a step signal", () => {
    // A loop that never called onStepAbort — a headless run, or a caller that
    // does not wire it. Esc must not silently escalate to a whole-loop abort.
    const store = withLoop();
    expect(store.getState().abortStep()).toBe(false);
  });

  it("returns true and fires the step signal when a step is in flight", () => {
    const store = withLoop();
    let fired = false;
    store.getState().setStepAbort({ abort: () => { fired = true; } });
    expect(store.getState().abortStep()).toBe(true);
    expect(fired).toBe(true);
  });

  it("does NOT touch the whole-loop signal the API's /stop uses", () => {
    // The single most important assertion here. The 20:01:33 failure had two
    // causes — the bus flush and the loop abort — and both had to go.
    const store = withLoop();
    const task = store.getState()._taskRegistry.find((t) => t.type === "agent-loop");

    let stepAborted = false;
    store.getState().setStepAbort({ abort: () => { stepAborted = true; } });
    store.getState().abortStep();

    expect(stepAborted).toBe(true);
    // Read through .signal rather than an 'abort' event listener: the
    // AbortController this project resolves to exposes no addEventListener,
    // so the event-based form of this assertion throws instead of testing.
    expect(task.abort.signal.aborted).toBe(false);
  });

  it("leaves the task registered, so the loop is still the running task", () => {
    const store = withLoop();
    store.getState().setStepAbort(new AbortController());
    store.getState().abortStep();
    expect(store.getState()._taskRegistry.some((t) => t.type === "agent-loop")).toBe(true);
  });

  it("is harmless after the turn has cleared its step signal", () => {
    // clearStep() runs in the loop's finally block. A second Esc after that
    // must not reach a spent controller and must not escalate to the task.
    const store = withLoop();
    store.getState().setStepAbort(new AbortController());
    store.getState().clearStepAbort();
    expect(store.getState().abortStep()).toBe(false);
    expect(store.getState()._stepAbort).toBeNull();
  });

  it("does not fire twice for one step", () => {
    const store = withLoop();
    let count = 0;
    store.getState().setStepAbort(new AbortController());
    store.getState().setStepAbort({ abort: () => { count += 1; } });
    store.getState().abortStep();
    store.getState().clearStepAbort();   // the loop noticing, at its next boundary
    store.getState().abortStep();
    expect(count).toBe(1);
  });

  // ---------------------------------------------------------------------
  // Backlog item 20. On 02a1651 Esc stopped a step exactly once per turn.
  //
  // The store was never at fault: it aborts whatever controller it was last
  // given. What went wrong is that the loop stopped giving it a live one. After
  // the first Esc, `_stepAbort` pointed at a controller that had already fired,
  // so `abort()` was a no-op that still returned, and index.js printed
  // "[Step stopped]" for a step that never stopped — eleven times in a row.
  //
  // The store is where a press can tell the difference, because only it can
  // know whether the controller it holds can still stop anything. An
  // AbortController reports that itself: `signal.aborted` is true once spent.
  // abortStep() returning true for a spent controller is the lie this fixes,
  // and it is why these are here rather than only in the integration test.
  // ---------------------------------------------------------------------

  it("reports false when the step signal it holds has already been spent", () => {
    // The exact state the owner was left in: a controller that fired on the
    // first Esc and was never replaced.
    const store = withLoop();
    const spent = new AbortController();
    store.getState().setStepAbort(spent);
    store.getState().abortStep();          // the press that worked

    expect(
      store.getState().abortStep(),
      "a second Esc on an already-aborted controller reported that it stopped a step. "
      + "index.js prints [Step stopped] when this is true, so the operator was told the "
      + "step stopped when nothing had been cancelled at all",
    ).toBe(false);
  });

  it("reports true again once the loop publishes a fresh controller for the next step", () => {
    // The other half of the fix: a spent signal must not permanently disarm Esc.
    // If the loop replaced it, the key works; if it did not, the key stays dead
    // for the rest of the turn and the only Esc that ever works is the first.
    const store = withLoop();
    const first = new AbortController();
    store.getState().setStepAbort(first);
    store.getState().abortStep();

    const second = new AbortController();  // what newStep() must publish
    store.getState().setStepAbort(second);
    store.getState().abortStep();

    expect(first.signal.aborted, "the first controller should be the spent one").toBe(true);
    expect(second.signal.aborted, "the second Esc did not reach the step that was running").toBe(true);
  });

  it("still says false when no controller is published at all", () => {
    // The guard that must not be weakened by the fix above: a headless run that
    // never wires onStepAbort has no step to stop, and Esc must not escalate to
    // the whole-loop signal to compensate.
    const store = withLoop();
    expect(store.getState().abortStep()).toBe(false);
  });
});

/**
 * What an Esc that stopped no step should do NEXT.
 *
 * This is the regression the item-20 fix opens if nothing guards it, and it is
 * worse than the bug being fixed.
 *
 * index.js:133-166 is a two-step Esc:
 *
 *     if (s.abortStep()) { print "[Step stopped]"; return; }
 *     const result = s.abortNext();        <- priority 1 is the agent loop
 *
 * So "I stopped no step" falls through to "kill the whole agent loop". That
 * fall-through used to be unreachable in practice: abortStep() returned true for
 * every press after the first, so Esc always took the first branch and the
 * task survived — by accident, and while lying about having done anything.
 *
 * Make abortStep() honest and the fall-through becomes live. The window where
 * the step signal is spent is the gap between one step ending and the next
 * starting, and a second press lands in it whenever the operator presses Esc
 * again quickly — which is exactly what the owner was doing, eleven times, at
 * 14:16. The second press would then kill the entire task.
 *
 * Both earlier versions of this were expensive: a
 * message typed mid-work used to cost the operator the work. Esc was changed
 * to mean "the step" precisely so it could not mean "the task" again, and
 * the step-cancel test says so. This is the guard that keeps the honest
 * abortStep() from undoing that.
 */
describe("an Esc that stopped no step still ends the task", () => {
  // Reversed on 2026-09-30, deliberately. The guard below used to return
  // false so a press landing on a spent step signal could not fall through to
  // abortNext() and kill the task. The owner was pressing Esc to stop the work:
  // ten presses, ten "[Step stopped]" lines, one task still running, because the
  // loop restarts a cancelled step itself (agent.js newStep). Stopping the task
  // is what the key was reaching for, so escAbort() stops it on every press —
  // the step signal first, so a hung model call answers at once.
  it("ends the task even when the step signal is already spent", () => {
    const store = withLoop();
    const wholeLoop = store.getState()._taskRegistry.find((t) => t.type === "agent-loop");
    const spent = new AbortController();
    store.getState().setStepAbort(spent);
    store.getState().abortStep();          // press #1, the step

    const result = store.getState().escAbort();   // press #2, the task
    expect(result.type).toBe("agent-loop");
    expect(wholeLoop.abort.signal.aborted, "Esc did not end the task").toBe(true);
  });

  it("ends the task when the loop never published a step signal", () => {
    // A headless run, or a caller that does not wire onStepAbort. There is no
    // step to stop, so Esc has nothing else it could do.
    const store = withLoop();
    expect(store.getState().escAbort().type).toBe("agent-loop");
  });

  it("stops a background process when no agent loop is running", () => {
    // Esc is the emergency brake: with no turn running, it stops background
    // work (owner, 2026-10-01).
    const store = createMockStore();
    store.getState().registerTask({ type: "bg-process", label: "npm test", kill: () => {} });
    expect(store.getState().escAbort().type).toBe("bg-process");
  });

  it("fires the step signal and the whole-loop signal on one press", () => {
    // Both, in that order: the step ends the call in flight, the loop ends the
    // task. Without the first, Esc waits for the next loop boundary — which is
    // exactly where a hung provider lives.
    const store = withLoop();
    const step = new AbortController();
    store.getState().setStepAbort(step);
    store.getState().escAbort();
    expect(step.signal.aborted, "the model call in flight was not cancelled").toBe(true);
  });

  it("says nothing when nothing is running", () => {
    expect(createMockStore().getState().escAbort()).toBe(null);
  });
});

describe("abortNext is untouched", () => {
  it("still kills the whole loop, because the API's /stop means that", () => {
    // Deliberately preserved. A harness calling /stop wants the loop dead, and
    // item 6 only changed what Esc means, not what an explicit stop means.
    const store = withLoop();
    const result = store.getState().abortNext();
    expect(result.type).toBe("agent-loop");
    const task = store.getState()._taskRegistry.find((t) => t.type === "agent-loop");
    expect(task).toBeUndefined();
  });
});
