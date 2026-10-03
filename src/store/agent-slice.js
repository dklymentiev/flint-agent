// Agent slice: status, currentTool, processingCount, pendingAction, toolActivities, thoughts
import { createLogger } from "../logging/logger.js";

const log = createLogger("agent-slice");

export const createAgentSlice = (set, get) => ({
  agentStatus: "idle", // idle | thinking | calling-tool | streaming
  currentTool: null,
  // { kind: "call"|"answering"|"tool"|"wait"|"stall", label, attempt } — the
  // current activity, with its own clock in activityStartedAt.
  activity: null,
  activityStartedAt: null,
  // Last output line of the command the activity is about (run_command), so a
  // long foreground command shows progress, not only a clock.
  activityDetail: null,
  activityTokens: 0,
  processingCount: 0,
  pendingAction: null, // null | "restart" | "clear-context"
  pendingConfirmation: null, // { id, toolName, args, resolve }
  pendingPairing: null, // { sessionId, pin, fromAddress, expiresAt }
  toolActivities: [],  // [{ id, name, args, result, status: "running"|"done", ts }]
  nextToolActivityId: 1,
  autoMode: null, // null | { iteration, maxIterations, cost, tasksDone, tasksTotal }
  thoughts: [],  // collapsed thinking blocks: [{ id, text, ts }]
  showThoughts: false, // toggle via Ctrl+T

  setAgentStatus(status, tool) {
    log.debug("setAgentStatus", { from: get().agentStatus, to: status, tool: tool || null });
    const update = { agentStatus: status, currentTool: tool || null };
    if (status !== "idle" && !get()._startedAt) update._startedAt = Date.now();
    if (status === "idle") update._startedAt = null;
    set(update);
  },

  /**
   * What Flint is doing right now, and the clock for THIS thing.
   *
   * The status line used to time the whole turn from `_startedAt`, and called
   * it "elapsed": after fifteen ordinary steps it read `thinking #15 468s`,
   * which is indistinguishable from a hung call. On 2026-09-29 a call that
   * never returned showed exactly that number for ten minutes and there was
   * nothing on screen saying it was waiting rather than working.
   *
   * So every change of activity restarts the clock, and the label says which
   * activity: waiting for the model, running a command, waiting to retry.
   * The number next to it is how long THIS has been going, which is the only
   * number an operator can act on.
   */
  setActivity({ kind, label, attempt, tool, arg } = {}) {
    set({
      activity: { kind: kind || "call", label: label || "", attempt: attempt || null, tool: tool || null, arg: arg || null },
      activityStartedAt: Date.now(),
      activityDetail: null,
      activityTokens: 0,
    });
  },

  /** Tokens streamed in the current model call, for the activity row. */
  setActivityTokens(n) {
    set({ activityTokens: n || 0 });
  },

  /** Update the detail without restarting the activity clock. */
  setActivityDetail(text) {
    set({ activityDetail: text || null });
  },

  clearActivity() {
    set({ activity: null, activityStartedAt: null, activityDetail: null, activityTokens: 0 });
  },

  incrementQueue() {
    set({ processingCount: get().processingCount + 1 });
  },

  decrementQueue() {
    set({ processingCount: Math.max(0, get().processingCount - 1) });
  },

  setPendingAction(action) {
    set({ pendingAction: action });
  },

  clearPendingAction() {
    set({ pendingAction: null });
  },

  setPendingConfirmation(conf) {
    set({ pendingConfirmation: conf });
  },

  clearPendingConfirmation() {
    set({ pendingConfirmation: null });
  },

  setPendingPairing(pairing) {
    set({ pendingPairing: pairing });
  },

  clearPendingPairing() {
    set({ pendingPairing: null });
  },

  addToolActivity({ name, args }) {
    const { toolActivities, nextToolActivityId } = get();
    const entry = { id: nextToolActivityId, name, args, result: "", status: "running", ts: Date.now() };
    const updated = [...toolActivities, entry];
    set({
      toolActivities: updated.length > 30 ? updated.slice(-30) : updated,
      nextToolActivityId: nextToolActivityId + 1,
    });
    return nextToolActivityId;
  },

  updateToolActivity(id, update) {
    const { toolActivities } = get();
    set({
      toolActivities: toolActivities.map((a) =>
        a.id === id
          ? { ...a, ...update, ...(update.status === "done" ? { endTs: Date.now() } : {}) }
          : a
      ),
    });
  },

  clearToolActivities() {
    set({ toolActivities: [], nextToolActivityId: 1 });
  },

  addThought(text) {
    const { thoughts } = get();
    const entry = { id: thoughts.length + 1, text, ts: Date.now() };
    set({ thoughts: [...thoughts, entry] });
  },

  toggleThoughts() {
    set({ showThoughts: !get().showThoughts });
  },

  clearThoughts() {
    set({ thoughts: [], showThoughts: false });
  },

  // -- TaskRegistry: track all running tasks for Escape abort --
  // Order: agent-loop first, then bg-processes (newest→oldest), then child-agents (newest→oldest)
  _taskRegistry: [],
  _nextTaskId: 1,

  registerTask({ type, label, abort, kill, pid, port }) {
    const { _taskRegistry, _nextTaskId } = get();
    const entry = { id: _nextTaskId, type, label, abort, kill, pid, port, ts: Date.now() };
    set({ _taskRegistry: [..._taskRegistry, entry], _nextTaskId: _nextTaskId + 1 });
    return _nextTaskId;
  },

  unregisterTask(id) {
    const { _taskRegistry } = get();
    set({ _taskRegistry: _taskRegistry.filter(t => t.id !== id) });
  },

  // -- Step-scoped abort for the agent loop (Esc) --
  //
  // The whole-loop controller is `signal` in the agent loop, registered above
  // as an "agent-loop" task. Esc must not reach that one. Esc means "stop the
  // step you are on", and until now that was the same call as killing the
  // task: on 2026-09-30 an answer to a question typed at 19:59:52 cost the
  // operator the question (bus flush) and the task (loop abort) in the same
  // instant. The API's /stop keeps the whole loop, deliberately — a harness
  // that calls /stop means it.
  _stepAbort: null,

  setStepAbort(abort) {
    set({ _stepAbort: abort || null });
  },

  clearStepAbort() {
    set({ _stepAbort: null });
  },

  /**
   * Stop the current step of the running agent loop, keeping the task.
   *
   * Returns true only when a step was actually stopped, so the caller can tell
   * "I interrupted something" from "there was nothing to interrupt" and stay
   * quiet about the latter.
   *
   * The loop notices by polling its own step signal at the top of the next
   * iteration. Nothing is called from here into the loop, so a step that
   * ignores its signal simply finishes and the task continues anyway.
   *
   * A controller that has already fired is not a step anybody can stop, so
   * this returns false for it.
   *
   * The check is the honest half of the fix. A spent AbortController's abort()
   * does nothing and does not complain, so before this the second and every
   * later Esc in a turn returned true, and index.js printed
   * "[Step stopped] — the task continues" for a step that was still running:
   * owner 2026-09-30 14:16, session 2026-09-30T19-05-41, eleven such lines
   * stacked on screen, none of them true. The loop now publishes a fresh
   * controller for every step (agent.js, newStep), so the spent state is only
   * ever the narrow window between one step ending and the next starting —
   * which is exactly the window in which the answer really is "nothing was
   * stopped".
   */
  abortStep() {
    const s = get();
    const loopIsRunning = s._taskRegistry.some(t => t.type === "agent-loop");
    if (!loopIsRunning || !s._stepAbort) return false;
    if (s._stepAbort.signal?.aborted) return false;
    s._stepAbort.abort();
    return true;
  },

  /**
   * What one Escape press means: end the agent task, keep the queue.
   *
   * Returns the task it stopped, or null when there was nothing to stop — the
   * caller prints nothing in that case.
   *
   * It was the step, and that was wrong for the operator who pressed it.
   * Owner, 2026-09-30: one question, then ten presses of Esc against the
   * running task. Ten "[Step stopped]" lines and the task carried on, because
   * the loop restarts a cancelled step itself (agent.js newStep) — so each
   * press stopped a step that the next instant began again, and the key
   * reported an interruption while producing none. Ten presses were one
   * message and one intent: stop.
   *
   * So the step signal is fired first (a model call in flight ends at once
   * rather than at the next loop boundary, which is where a hung call lives)
   * and then the whole-loop signal ends the task itself.
   *
   * The queue is NOT touched, and that half is not optional. flush() fails
   * every pending bus message as "flushed": session 2026-09-30T00-37-42 lost
   * the question typed at 19:59:52 and the task it was asking about 19 ms
   * apart, from one press. Esc keeps the queue; `stop` is the word that
   * discards it, and the API's /stop still means the whole task.
   */
  escAbort() {
    const s = get();
    const loopIsRunning = s._taskRegistry.some(t => t.type === "agent-loop");
    if (loopIsRunning) {
      // Both signals, in that order: the step ends the call, the loop ends the
      // task. abortStep() is the one that must not be skipped — it is what
      // makes the key answer on a hung provider instead of at the next boundary.
      s.abortStep();
      return get().abortNext();
    }
    // No agent task: Esc is the emergency brake for background work, newest
    // first, one per press (owner, 2026-10-01: "if something was started by
    // accident, I must be able to stop it fast"). abortNext() is that order:
    // background processes newest first, then child agents.
    return get().abortNext();
  },

  /**
   * Abort next task in priority order:
   * 1. agent-loop (if active)
   * 2. bg-process (newest first)
   * 3. child-agent (newest first)
   * Returns { type, label } of aborted task, or null if nothing to abort.
   */
  abortNext() {
    const { _taskRegistry } = get();
    if (!_taskRegistry.length) return null;

    // Priority 1: agent-loop
    const agentLoop = _taskRegistry.find(t => t.type === "agent-loop");
    if (agentLoop) {
      if (agentLoop.abort) agentLoop.abort.abort();
      set({ _taskRegistry: _taskRegistry.filter(t => t.id !== agentLoop.id) });
      return { type: agentLoop.type, label: agentLoop.label };
    }

    // Priority 2: bg-process (newest first)
    const bgProcesses = _taskRegistry.filter(t => t.type === "bg-process").sort((a, b) => b.ts - a.ts);
    if (bgProcesses.length) {
      const target = bgProcesses[0];
      if (target.kill) target.kill();
      set({ _taskRegistry: _taskRegistry.filter(t => t.id !== target.id) });
      return { type: target.type, label: target.label };
    }

    // Priority 3: child-agent (newest first)
    const agents = _taskRegistry.filter(t => t.type === "child-agent").sort((a, b) => b.ts - a.ts);
    if (agents.length) {
      const target = agents[0];
      if (target.kill) target.kill();
      set({ _taskRegistry: _taskRegistry.filter(t => t.id !== target.id) });
      return { type: target.type, label: target.label };
    }

    return null;
  },

  abortAll() {
    const { _taskRegistry } = get();
    const results = [];
    for (const task of _taskRegistry) {
      if (task.abort) task.abort.abort();
      if (task.kill) task.kill();
      results.push({ type: task.type, label: task.label });
    }
    set({ _taskRegistry: [] });
    return results;
  },
});
