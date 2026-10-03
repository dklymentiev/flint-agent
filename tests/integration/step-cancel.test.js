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
//
// These run the real loop. The unit tests in step-abort.test.js cover the
// store's half; a policy that the loop never consults is the trap that let the
// original bug through.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../src/config.js", () => ({
  config: {
    apiKey: "test-key", model: "test-model", intentModel: "test/intent-model",
    apiUrl: "https://test.api/v1/chat/completions", provider: "openrouter",
    projectRoot: process.cwd(), maxIterations: 50, maxResponseTokens: 2048,
    maxCostPerAction: 0, sessionBudget: 0, selfVerify: "off", headless: false,
    fallbackAllTools: false, sessionsDir: process.env.FLINT_DATA_DIR || process.cwd(),
    workdir: process.cwd(),
  },
}));
vi.mock("../../src/agent/modes.js", () => ({ getModeForIntent: () => null, listModes: () => [] }));
vi.mock("../../src/memory/store.js", () => ({
  loadAll: () => [], insertMemory: () => ({}), searchMemories: () => [], getMemory: () => null,
  listRecentMemories: () => [], deleteMemory: () => false,
  getMemoryStats: () => ({ total: 0, byCategory: {}, oldest: null, newest: null }),
  clearAllMemories: vi.fn(),
}));
vi.mock("../../src/memory/markdown.js", () => ({ updateMemoryMd: vi.fn(), readMemoryMdHead: () => "" }));
vi.mock("../../src/memory/facts.js", () => ({ extractFacts: () => [], addFact: () => {}, formatForPrompt: () => "" }));
vi.mock("../../src/memory/user-model.js", () => ({ observeUser: () => {}, formatForPrompt: () => "" }));
vi.mock("../../src/memory/patterns.js", () => ({ recordPattern: () => {}, compilePreferences: () => ({}), formatForPrompt: () => "" }));

function sse(delta) {
  const text = `data: ${JSON.stringify({ id: "g1", choices: [{ delta }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`;
  const bytes = new TextEncoder().encode(text);
  let done = false;
  return new ReadableStream({ pull(c) { if (done) { c.close(); return; } c.enqueue(bytes); done = true; } });
}
const textSse = (content) => sse({ content });
const toolSse = (name, args) => sse({ tool_calls: [{ index: 0, id: `c-${name}`, function: { name, arguments: JSON.stringify(args) } }] });

const MANIFEST = {
  intent: "complex_multi",
  tools: ["read_file", "write_file", "edit_file", "run_command", "think", "web_search"],
  assessment: "normal", requires_prior_tool_call: [],
  user_wants: "do the work", reason: "multi-step",
};
function isClassifier(body) {
  const s = String((body.messages || []).find((m) => m.role === "system")?.content || "");
  return s.includes("INTENT_CLASSES");
}

let originalFetch;
beforeEach(() => {
  originalFetch = globalThis.fetch;
  process.env.AGENT_BACKOFF_MS = "1";
  // Long: an Esc is the only thing that can end the wait, which is the point.
  process.env.AGENT_FIRST_TOKEN_TIMEOUT_MS = "60000";
  process.env.AGENT_STALL_MAX_ATTEMPTS = "9";
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const k of ["AGENT_BACKOFF_MS", "AGENT_FIRST_TOKEN_TIMEOUT_MS", "AGENT_STALL_MAX_ATTEMPTS"]) {
    delete process.env[k];
  }
});

/**
 * The real loop, wired to the store the way message-handler.js wires it: the
 * whole-loop signal in the task registry, the step signal published by the
 * loop itself. That wiring is the fix; reproducing it here is the only way the
 * test can fail if the loop stops consulting the step signal.
 */
async function loadLoop() {
  const { initRegistry } = await import("../../src/tools/registry.js");
  const { runAgent } = await import("../../src/agent/agent.js");
  const { createMockStore } = await import("../helpers/mock-store.js");
  const store = createMockStore();
  initRegistry(store);

  const wholeLoop = new AbortController();
  store.getState().registerTask({ type: "agent-loop", label: "agent loop", abort: wholeLoop });

  const start = (messages) => runAgent(messages, {
    onStepAbort(controller) { store.getState().setStepAbort(controller); },
  }, { signal: wholeLoop.signal });

  return { store, start, wholeLoop };
}

const messages = [
  { role: "system", content: "You are helpful" },
  { role: "user", content: "read the config, then summarise it" },
];

/**
 * Every call but the last hangs forever, so each Esc has something to cancel.
 *
 * Backlog item 20: the owner pressed Esc repeatedly and got "[Step stopped]"
 * every time while nothing stopped. One hung call can only prove that ONE Esc
 * reached a call. Reproducing that honestly needs as many hangs as there are
 * presses, so calls 2..HANGS+1 all wait and only the last one answers.
 *
 * The counter is exported so a test can wait for "the next call started",
 * which is the only observation that distinguishes "Esc cancelled the call" from
 * "Esc returned true and nothing happened".
 */
const HANGS = 3;
const hangFetch = () => {
  let agentCalls = 0;
  const state = { get calls() { return agentCalls; } };
  state.fetch = vi.fn(async (_url, init) => {
    const body = JSON.parse(init.body);
    if (isClassifier(body)) {
      return {
        ok: true, status: 200,
        json: async () => ({ choices: [{ message: { content: JSON.stringify(MANIFEST) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
        text: async () => "",
      };
    }
    agentCalls++;
    if (agentCalls === 1) return { ok: true, body: toolSse("read_file", { path: "config.json" }) };
    if (agentCalls <= HANGS + 1) {
      // A request the provider accepts and never answers, which errors its
      // body stream when the signal aborts. Honouring the signal is what lets
      // this tell "the cancel never arrived" apart from "the mock ignored it".
      const signal = init.signal;
      const hung = new ReadableStream({
        start(controller) {
          signal?.addEventListener("abort", () => {
            controller.error(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
          }, { once: true });
        },
      });
      return { ok: true, status: 200, body: hung };
    }
    return { ok: true, body: textSse("The config sets the port to 3000.") };
  });
  return state;
};

/** Poll until `pred` holds, so a failure is a failed assertion and not a hang. */
async function waitFor(pred, ms, what) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return pred();
}

/** Step 1 calls a tool, step 2 hangs, step 3 is the answer. */
function threeStepFetch() {
  let agentCalls = 0;
  return vi.fn(async (_url, init) => {
    const body = JSON.parse(init.body);
    if (isClassifier(body)) {
      return {
        ok: true, status: 200,
        json: async () => ({ choices: [{ message: { content: JSON.stringify(MANIFEST) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
        text: async () => "",
      };
    }
    agentCalls++;
    if (agentCalls === 1) return { ok: true, body: toolSse("read_file", { path: "config.json" }) };
    if (agentCalls === 2) {
      // A request the provider accepts and never answers.
      //
      // It must honour the abort signal, or this test cannot distinguish "the
      // cancel never reached the call" from "the mock ignored it": a stream
      // that simply never enqueues stays pending forever no matter who aborts
      // it, and every cancellation path times out identically. A real fetch
      // errors the body stream on abort, so this one does too.
      const signal = init.signal;
      const body = new ReadableStream({
        start(controller) {
          signal?.addEventListener("abort", () => {
            controller.error(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
          }, { once: true });
          // Never enqueues, never closes on its own: a hung provider.
        },
      });
      return { ok: true, status: 200, body };
    }
    return { ok: true, body: textSse("The config sets the port to 3000.") };
  });
}

describe("Esc during a model call stops the step, not the task", () => {
  it("carries on to the next step and finishes the task", async () => {
    globalThis.fetch = threeStepFetch();
    const { store, start } = await loadLoop();

    const promise = start(messages);
    await new Promise((r) => setTimeout(r, 400));

    // Esc. This used to kill the task outright.
    expect(store.getState().abortStep()).toBe(true);

    const res = await promise;

    // The work survived and produced its answer.
    expect(res.stop_reason).toBe("done");
    expect(res.text).toContain("port");
  }, 30000);

  it("leaves the whole-loop signal alone, so the API's /stop still works", async () => {
    globalThis.fetch = threeStepFetch();
    const { store, start, wholeLoop } = await loadLoop();

    const promise = start(messages);
    await new Promise((r) => setTimeout(r, 400));
    store.getState().abortStep();
    const res = await promise;

    expect(res.stop_reason).toBe("done");
    // Esc must not have taken the loop down with it.
    expect(wholeLoop.signal.aborted).toBe(false);
  }, 30000);

  it("still ends the task when the whole-loop signal fires", async () => {
    // The other meaning, deliberately preserved: a harness calling /stop wants
    // the loop dead. Item 6 changed what Esc means, not what a stop means.
    globalThis.fetch = threeStepFetch();
    const { start, wholeLoop } = await loadLoop();

    const promise = start(messages);
    await new Promise((r) => setTimeout(r, 400));
    wholeLoop.abort();

    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
  }, 30000);

  it("keeps the task registered while a step is cancelled", async () => {
    globalThis.fetch = threeStepFetch();
    const { store, start } = await loadLoop();

    const promise = start(messages);
    await new Promise((r) => setTimeout(r, 400));
    store.getState().abortStep();

    // Mid-flight: the task is still the running task, not a finished one.
    expect(store.getState()._taskRegistry.some((t) => t.type === "agent-loop")).toBe(true);

    const res = await promise;
    expect(res.stop_reason).toBe("done");
  }, 30000);
});

/**
 * Backlog item 20. Owner, 2026-09-30 14:16, session 2026-09-30T19-05-41,
 * master 02a1651: Esc pressed several times printed "[Step stopped] — the task
 * continues" every single time, and the running step did not stop. Eleven of
 * those lines were on screen at once.
 *
 * WHY THE FIRST PRESS WORKED AND THE REST DID NOT:
 *
 * The loop creates a step controller once and publishes it once:
 *
 *     let stepController = new AbortController();
 *     const newStep = () => { stepController = new AbortController(); return stepController; };
 *     newStep();
 *     onStepAbort?.(stepController);        <- the only call
 *
 * `newStep()` then runs twice more — after a cancelled step (agent.js:592) and
 * after an Esc that interrupted a model call (agent.js:796) — and each time it
 * REPLACES the variable. Nobody tells the store. `_stepAbort` keeps pointing at
 * the controller that was published at loop start, which aborted once and has
 * been spent ever since: `abort()` on it is a no-op that still returns, so
 * abortStep() reported success and index.js printed "[Step stopped]" for a
 * step that never stopped.
 *
 * So the first Esc cancels a real call and every Esc after it cancels nothing,
 * while the screen insists each one worked. The message is the only thing the
 * operator has to go on, which is what makes this worse than a dead key.
 *
 * WHAT IS ASSERTED, and the trap avoided:
 *
 * `abortStep()` returning true proves nothing — it returned true eleven times
 * in the session above. Each press is therefore followed by a wait for the NEXT
 * model call to start, which is the only observation that distinguishes "the
 * cancel reached a call" from "the code reported success and nothing happened".
 * One hung call cannot carry this test: it only proves that ONE Esc arrived.
 * Hence HANGS: calls 2..4 each wait, so the second and third presses each have
 * a live call of their own to cancel.
 *
 * The hung stream honours its signal. If it did not, an abort would be
 * indistinguishable from a mock that ignored it and this file would pass for
 * the wrong reason — the mistake the call-2 stream above already documents.
 */
describe("Esc stops whichever step is running at that moment", () => {
  it("a second and a third Esc each stop the then-current step, and the task still finishes", async () => {
    const hung = hangFetch();
    globalThis.fetch = hung.fetch;
    const { store, start } = await loadLoop();

    const promise = start(messages);

    // Call 1 calls a tool, call 2 hangs. Wait for the hang rather than for a
    // fixed delay, so the presses below land on a call that exists.
    expect(
      await waitFor(() => hung.calls >= 2, 5000),
      "the loop never reached the first hung model call",
    ).toBe(true);

    // -- Esc #1: the step that works today, and the control for the two below.
    expect(store.getState().abortStep(), "the first Esc did not stop the step").toBe(true);
    expect(
      await waitFor(() => hung.calls >= 3, 5000),
      "the first Esc reported success but the model call kept running",
    ).toBe(true);

    // -- Esc #2: printed "[Step stopped]" on 02a1651 and cancelled nothing.
    expect(
      store.getState().abortStep(),
      "the second Esc did not reach the step running at that moment",
    ).toBe(true);
    expect(
      await waitFor(() => hung.calls >= 4, 5000),
      "the second Esc reported success but no step was stopped: on 02a1651 the store "
      + "still held the controller that the first Esc had already spent, so abort() was "
      + "a no-op that still returned true",
    ).toBe(true);

    // -- Esc #3: the same, one step further on.
    expect(
      store.getState().abortStep(),
      "the third Esc did not reach the step running at that moment",
    ).toBe(true);
    expect(
      await waitFor(() => hung.calls >= 5, 5000),
      "the third Esc reported success but no step was stopped",
    ).toBe(true);

    // And the task survived all three: Esc stops steps, never the task.
    const res = await promise;
    expect(res.stop_reason).toBe("done");
    expect(res.text).toContain("port");
  }, 30000);

  it("a second Esc on a step that is already stopping does not claim to have stopped one", async () => {
    // The other half of item 20: "[Step stopped]" must appear only when a step
    // was actually stopped. A second press while the same step is still winding
    // down reaches a spent controller, and a spent controller cannot stop
    // anything — so reporting success is the lie the owner saw eleven times.
    //
    // The store half of this is in tests/unit/store/step-abort.test.js; what is
    // checked here is that the loop makes such a press possible in the first
    // place, by publishing a fresh controller for every step it starts.
    const hung = hangFetch();
    globalThis.fetch = hung.fetch;
    const { store, start, wholeLoop } = await loadLoop();

    const promise = start(messages);
    expect(await waitFor(() => hung.calls >= 2, 5000)).toBe(true);

    expect(store.getState().abortStep()).toBe(true);
    // Straight on, before the loop has noticed and replaced the controller. The
    // assertion below is what the owner cares about, and it holds either way —
    // a press on a live step is true, a press on a spent one is false.
    const second = store.getState().abortStep();

    expect(
      second,
      "two presses with no step started in between both reported stopping a step, so the "
      + "second press printed a [Step stopped] line for a step that was never stopped",
    ).toBe(false);

    // Ended on the whole-loop signal rather than by waiting for the turn.
    //
    // This mock hangs on calls 2, 3 and 4, and the assertion above cancels only
    // call 2 — so calls 3 and 4 are still waiting on a provider that will never
    // answer, and nothing is left to cancel them. Awaiting the turn here waits
    // for the 60s first-token timeout twice over. The whole-loop signal is how
    // a turn is meant to be ended, so that is what this uses, and it also
    // leaves nothing running to bleed into the next test.
    wholeLoop.abort();
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
  }, 30000);
});
