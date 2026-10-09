// Bus drain loop — single consumer that processes all messages from the bus
// Replaces withLock/drainQueue. All channels push to bus, this loop processes sequentially.

import chalk from "chalk";
import { store } from "../store/index.js";
import { app } from "../app-state.js";
import { processMessage, handlePendingAction } from "../message-handler.js";
import { userMsgLine } from "../ui/header.js";
import * as bus from "./index.js";
import { createLogger } from "../logging/logger.js";
import { setSupervisorEnabled } from "../agent/supervisor.js";
import {
  shouldContinue, isLearningOpportunity, setUserInterrupt, resetFlow,
  FATAL_PROVIDER_REASONS, MAX_CONSECUTIVE_RATE_LIMITS, RATE_LIMIT_WAIT_MS, STOP_REASON_TEXT,
} from "../agent/flow-controller.js";
import { extractLearnings } from "../agent/learning.js";
import { config } from "../config.js";
import { bulkSetPermission, setUnattended } from "../tools/permissions.js";
import { getActivePlan, getActiveGoals } from "../tasks/queries.js";

const log = createLogger("bus-drain");

let _running = false;
let _drainResolvers = new Map(); // busId → { resolve, reject } for sync API callers
const _asyncResults = new Map(); // busId → { response, stats, error, ts } for async poll
const ASYNC_RESULT_TTL = 3600000; // 1 hour
let _continueTimer = null; // scheduled self-continue timer (clearable on flush)

// Autonomous no-progress guard — track tool-call signatures of the last N
// self-continue iterations. If N in a row are identical, the agent is stuck
// in a loop (typical pattern: repeatedly calling update_task with the same
// args because the server rejects it each time, hallucinating success in
// the response text). Halt autonomous when detected. Observed 2026-04-21:
// a probe run entered autonomous mode, then re-ran "update task N to
// in_progress" 50+ times burning $0.10+ before the user noticed.
const _autonomousSignatureHistory = []; // ring buffer, last N signatures
const AUTONOMOUS_NO_PROGRESS_THRESHOLD = 3;

// How long to wait before handing the run its next turn. Three seconds for a
// normal continue; a rate-limited turn waits out the provider's window instead.
const CONTINUE_DELAY_MS = 3000;

// Consecutive 429s. It lives here and not in flow-controller because
// resetFlow() runs at the top of every agent invocation, which would wipe it
// once per turn and it would never count past one.
let _rateLimitedInARow = 0;

function _toolCallSignature(toolCalls) {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return "::none::";
  return toolCalls
    .map((c) => `${c.name}:${JSON.stringify(c.arguments || {}).slice(0, 200)}`)
    .join("|");
}

// RX-2 fix: track per-message abort controllers so we can cancel a specific
// in-flight message when its sync HTTP client disconnects. Prevents the
// "processing slot stuck forever" bug we hit on admin-008 during first live run.
const _processingControllers = new Map(); // busId → AbortController

/**
 * Notify the drain loop that a new message is available.
 * Call this after bus.push().
 * Uses setImmediate to let Ink render the user's message first.
 */
export function notify() {
  if (!_running) {
    // setImmediate ensures UI updates (user message line) render before processing starts
    setImmediate(() => _tick());
  }
}

/**
 * Wait for a specific bus message to be processed.
 * Used by API server for sync responses.
 * @param {number} busId
 * @param {number} [timeoutMs=180000]
 * @returns {Promise<{response: string, stats: object}|{error: string}>}
 */
export function waitForResult(busId, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    _drainResolvers.set(busId, { resolve, reject });
    // Timeout safety
    setTimeout(() => {
      if (_drainResolvers.has(busId)) {
        _drainResolvers.delete(busId);
        resolve({ error: "timeout" });
      }
    }, timeoutMs);
  });
}

/**
 * RX-2 fix: Abort a specific in-flight message by bus ID.
 *
 * Called from the HTTP server when the sync client disconnects mid-request.
 * Finds the AbortController for that message and aborts it. The agent loop
 * catches the AbortError in its try/catch/finally and properly calls
 * bus.fail() which releases the processing slot.
 *
 * Also wakes any waiting sync caller with an aborted result so the HTTP
 * response handler can clean up (though the disconnected client will not
 * see it — that's fine).
 *
 * @param {number} busId
 * @returns {boolean} true if an abort was delivered, false if message not in flight
 */
export function abortMessage(busId) {
  const controller = _processingControllers.get(busId);
  if (controller) {
    try { controller.abort(new Error("client-disconnect")); } catch {}
  }
  const waiter = _drainResolvers.get(busId);
  if (waiter) {
    _drainResolvers.delete(busId);
    try { waiter.resolve({ error: "aborted" }); } catch {}
  }
  return !!controller;
}

/**
 * Abort ALL in-flight messages. Used by `/new` to stop any API traffic before
 * clearing the screen, so the TUI does not render leftover tokens on top of
 * the fresh banner.
 *
 * @returns {number} number of messages aborted
 */
export function abortAll() {
  let count = 0;
  for (const [busId, controller] of _processingControllers.entries()) {
    try { controller.abort(new Error("session-reset")); count++; } catch {}
    const waiter = _drainResolvers.get(busId);
    if (waiter) {
      _drainResolvers.delete(busId);
      try { waiter.resolve({ error: "aborted" }); } catch {}
    }
  }
  return count;
}

/**
 * Process one message from the bus.
 */
async function _processOne(msg) {
  store.getState().incrementQueue();
  // Only show message line for non-TUI channels (TUI already displayed it in submit handler)
  // A message that waited above the input is read now: into the history.
  const waited = store.getState().takeQueuedInput?.(msg.id);
  if (waited) userMsgLine(waited.display);
  if (msg.channel !== "user") {
    // No blank line here: the previous turn already ends with one, and two
    // stacked up before every API message (owner, 2026-10-01).
    userMsgLine(msg.content, msg.source);
  }

  // User interrupt detection: if a non-self-continue message arrives while
  // there's an active plan with pending tasks, the user is taking control.
  // Set the interrupt flag so shouldContinue() returns stop instead of
  // generating another auto-Continue message. Permanent fix for an issue
  // first seen in v1.0.0 where the user typing "stop" was ignored because the
  // drain loop kept auto-continuing.
  const isSelfContinue = msg.source === "self-continue";
  if (!isSelfContinue && (app.autonomous || msg.channel === "api")) {
    // Cancel any pending auto-continue timer immediately
    if (_continueTimer) {
      clearTimeout(_continueTimer);
      _continueTimer = null;
      log.info("drain: cancelled pending auto-continue (user message arrived)");
    }
    if (msg.channel === "api") {
      // An API message is a new task, not an interruption of one: it starts
      // with fresh run-level state and is allowed to self-continue.
      resetFlow();
    } else if (msg.source !== "auto") {
      // A person typing during an autonomous run takes control. The /auto
      // start message (source "auto") is the run itself, not an interrupt.
      setUserInterrupt(true);
    }
  }
  // Reset no-progress guard history on any non-self-continue message — the
  // user (or another channel) has taken control, so any prior stuck-loop
  // detection is no longer relevant.
  if (!isSelfContinue) {
    _autonomousSignatureHistory.length = 0;
  }

  let result = null;
  let error = null;
  // Auto-approve tools for API, agent, and autonomous channels
  const isRemote = msg.channel === "api" || msg.channel === "agent" || msg.channel === "autonomous";
  if (isRemote && config.apiAutoApprove) {
    bulkSetPermission("allow");
  }
  // Auto-approve does not cover everything: a hook can still force a prompt for
  // a dangerous command or a secret file, and there is nobody here to answer it.
  setUnattended(isRemote);
  // Auto-enable supervisor for API messages (mid-task detection, verify hints)
  if (isRemote) {
    setSupervisorEnabled(true);
  }
  // Context isolation: clear stale summary for API messages
  // Each API message is an independent task — previous task summary shouldn't leak
  if (msg.channel === "api" && msg.source !== "self-continue") {
    store.getState().setLastSummary("");
  }
  // Eager tool loading: wait for MCP tools before processing
  // Prevents agent from making decisions with incomplete tool set
  if (isRemote && !app.mcpReady) {
    const maxWait = 15000; // 15s max
    const start = Date.now();
    while (!app.mcpReady && Date.now() - start < maxWait) {
      await new Promise(r => setTimeout(r, 500));
    }
    if (app.mcpReady) {
      log.info("mcp-ready: tools loaded before processing API message");
    } else {
      log.warn("mcp-not-ready: proceeding with incomplete tools after %dms", maxWait);
    }
  }
  // RX-2 fix: create per-message AbortController, register in map so
  // abortMessage(busId) can cancel this specific in-flight message when
  // its sync client disconnects.
  const msgAbortController = new AbortController();
  _processingControllers.set(msg.id, msgAbortController);

  try {
    const sender = isRemote ? msg.source : null;
    result = await processMessage(msg.content, sender, { signal: msgAbortController.signal });
    await handlePendingAction();
    bus.complete(msg.id, result?.text?.slice(0, 500) || "ok");
  } catch (err) {
    error = err;
    if (err.name !== "AbortError" && !err.message?.includes("borted")) {
      store.getState().addLine(chalk.red(`Error: ${err.message}`));
      bus.fail(msg.id, err.message);
    } else {
      bus.fail(msg.id, "aborted");
    }
  } finally {
    // RX-2 fix: always clean up the processing controller so stale entries
    // do not leak into the map across multiple messages.
    _processingControllers.delete(msg.id);
    // Restore default permissions after remote message
    if (isRemote && config.apiAutoApprove) {
      bulkSetPermission(null); // clear global override
    }
    setUnattended(false);
    store.getState().decrementQueue();
  }
  // No blank line after the turn: userMsgLine opens the next message with
  // one, and two stacked up between turns (owner, 2026-10-01).

  // Store result for async poll
  const stopReason = result?.stop_reason || (error ? "error" : "done");
  const resultData = error
    ? { error: error.message, ts: Date.now() }
    // toolCalls belong here too. The sync waiter below has always returned them,
    // the async poll path never did, so anything that measures Flint through
    // POST /message + GET /message/:id saw an empty tool list and scored every
    // tool-backed probe as a miss. The readiness harness is exactly that.
    : { response: result?.text || "", stats: result?.stats || {}, stop_reason: stopReason,
        toolCalls: result?.toolCalls || [], repoClaimGap: result?.repoClaimGap || false, truncated_at: result?.truncated_at || null, ts: Date.now() };
  _asyncResults.set(msg.id, resultData);

  // Resolve waiting API callers (sync mode)
  const waiter = _drainResolvers.get(msg.id);
  if (waiter) {
    _drainResolvers.delete(msg.id);
    if (error) {
      waiter.resolve({ error: error.message });
    } else {
      waiter.resolve({ response: result?.text || "", stats: result?.stats || {}, stop_reason: stopReason, toolCalls: result?.toolCalls || [], repoClaimGap: result?.repoClaimGap || false, truncated_at: result?.truncated_at || null });
    }
  }

  // Track API goal: remember which goal this API task is working on
  if (msg.channel === "api" && msg.source !== "self-continue") {
    app.apiGoalId = null; // new API task — clear previous
  }
  // After any message: if API-scoped and no goal tracked yet, check if one was just created
  if (app.apiGoalId === null && (msg.channel === "api" || (msg.channel === "autonomous" && msg.source === "self-continue"))) {
    const plan = getActivePlan(store);
    if (plan?.goalId) {
      app.apiGoalId = plan.goalId;
      log.info("api-goal-tracked", { goalId: plan.goalId });
    }
  }

  // Flow control: decide whether to continue
  if ((app.autonomous || isRemote) && !error && stopReason !== "budget") {
    // A provider refusal is not a flow decision: no prompt changes it, so it is
    // settled before shouldContinue is asked anything. It used to fall straight
    // through, because the only guard here was for "budget" and shouldContinue
    // does not look at stopReason at all. A plan with pending tasks therefore
    // meant "keep going", and a run against a dead account spent three more
    // turns failing identically until the no-progress guard halted it and told
    // the operator the agent was stuck and to use /continue. Wrong cause, and a
    // suggestion that could not work. Measured before the fix: five turns, and
    // the word "provider" appearing nowhere.
    if (FATAL_PROVIDER_REASONS.has(stopReason)) {
      _rateLimitedInARow = 0;
      _autonomousSignatureHistory.length = 0;
      app.apiGoalId = null;
      log.warn("flow: provider refused, stopping", { stopReason });
      store.getState().addLine(chalk.yellow(
        `  [flow] Stopped: ${STOP_REASON_TEXT[stopReason] || stopReason} (${stopReason}).`
      ));
      if (result?.text) store.getState().addLine(chalk.hex("#555")(`  ${result.text.slice(0, 300)}`));
      return;
    }

    // A 429 is survivable, and the same decision the /auto loop makes:
    // wait out the window the provider asked for and take the turn again. Only
    // a cap that will not lift ends the run.
    let continueDelayMs = CONTINUE_DELAY_MS;
    if (stopReason === "rate-limit") {
      _rateLimitedInARow++;
      if (_rateLimitedInARow > MAX_CONSECUTIVE_RATE_LIMITS) {
        _rateLimitedInARow = 0;
        _autonomousSignatureHistory.length = 0;
        app.apiGoalId = null;
        log.warn("flow: rate limit did not lift, stopping", { stopReason });
        store.getState().addLine(chalk.yellow(
          `  [flow] Stopped: ${STOP_REASON_TEXT["rate-limit"]} (rate-limit).`
        ));
        return;
      }
      continueDelayMs = result?.retryAfter != null ? result.retryAfter * 1000 : RATE_LIMIT_WAIT_MS;
      store.getState().addLine(chalk.yellow(
        `  [flow] Rate limited by the provider. Waiting ${Math.round(continueDelayMs / 1000)}s, ` +
        `then retrying (${_rateLimitedInARow} of ${MAX_CONSECUTIVE_RATE_LIMITS}).`
      ));
    } else {
      _rateLimitedInARow = 0;
    }

    const plan = getActivePlan(store);
    const decision = shouldContinue({
      stopReason,
      plan,
      isApiScoped: !!app.apiGoalId,
      apiGoalId: app.apiGoalId,
      // API self-continue is opt-in: only the autonomous flag (set by
      // body.autonomous=true in the API request, or by /auto in TUI) enables
      // self-continue for API-scoped runs. Without it, an API message that
      // creates a plan with pending tasks stops after one turn.
      apiSelfContinue: app.apiSelfContinue || app.autonomous,
    });

    if (decision.action === "stop") {
      if (decision.goalComplete) {
        // Learning: extract patterns from completed task
        const plan = getActivePlan(store);
        if (isLearningOpportunity({ plan, toolCallCount: store.getState().messages?.length || 0 })) {
          try {
            extractLearnings({
              messages: store.getState().messages || [],
              task: msg.content || "",
              plan,
              outcome: "success",
            });
          } catch (e) { log.warn("learning-failed", { error: e.message }); }
        }
        app.apiGoalId = null;
      }
      log.info("flow: stop", { reason: stopReason });
    } else if (decision.action === "continue") {
      // No-progress guard: track signatures of recent autonomous iterations.
      // Reset the history whenever a non-self-continue message is processed
      // (handled at the top of this function via _autonomousSignatureHistory.length = 0
      // when msg.source !== "self-continue").
      // A turn the provider refused is not evidence that the agent is stuck:
      // it did nothing because it was not served. Counting those signatures
      // made the no-progress guard fire first and take the blame for a rate
      // limit.
      if (msg.source === "self-continue" && stopReason !== "rate-limit") {
        const sig = _toolCallSignature(result?.toolCalls);
        _autonomousSignatureHistory.push(sig);
        while (_autonomousSignatureHistory.length > AUTONOMOUS_NO_PROGRESS_THRESHOLD) {
          _autonomousSignatureHistory.shift();
        }
        const stuck = _autonomousSignatureHistory.length === AUTONOMOUS_NO_PROGRESS_THRESHOLD
          && _autonomousSignatureHistory.every((s) => s === _autonomousSignatureHistory[0]);
        if (stuck) {
          log.warn("autonomous: halt on no-progress", { signature: sig, count: _autonomousSignatureHistory.length });
          store.getState().addLine(chalk.yellow(
            `  [flow] Halted: ${AUTONOMOUS_NO_PROGRESS_THRESHOLD} identical autonomous iterations detected (no progress). Use /continue to resume.`
          ));
          _autonomousSignatureHistory.length = 0;
          app.apiGoalId = null;
          return;
        }
      }

      _continueTimer = setTimeout(() => {
        _continueTimer = null;
        if (app.queueAborted) return; // abort happened while waiting
        bus.push({ channel: "autonomous", content: decision.prompt, priority: bus.PRIORITY?.TASK || 5, source: "self-continue" });
        store.getState().addLine(chalk.hex("#555")("  [flow] Continuing..."));
        notify();
      }, continueDelayMs);
    }
  }
}

// _scheduleAutoContinue logic moved to flow-controller.js shouldContinue()
/** Reset autonomous state (call on new autonomous run) */
export function resetAutonomous() {
  if (_continueTimer) {
    clearTimeout(_continueTimer);
    _continueTimer = null;
  }
  _rateLimitedInARow = 0;
  _autonomousSignatureHistory.length = 0;
  // A new run starts with no interrupt and fresh retry/completion caps.
  resetFlow();
}

/**
 * Get async result for a processed message.
 * Returns full response+stats (not truncated like bus DB result).
 * @param {number} busId
 * @returns {{ response?: string, stats?: object, error?: string } | null}
 */
export function getAsyncResult(busId) {
  const r = _asyncResults.get(busId);
  if (!r) return null;
  // Cleanup on read (one-time fetch is enough)
  _asyncResults.delete(busId);
  return r;
}

/** Periodic cleanup of stale async results */
setInterval(() => {
  const now = Date.now();
  for (const [id, r] of _asyncResults) {
    if (now - r.ts > ASYNC_RESULT_TTL) _asyncResults.delete(id);
  }
}, 300000); // every 5 min

/**
 * Drain loop tick — process all pending messages, then stop.
 * Re-triggered by notify() when new messages arrive.
 */
async function _tick() {
  if (_running) return; // already draining
  _running = true;

  try {
    let msg;
    while ((msg = bus.drain())) {
      if (app.queueAborted) {
        bus.fail(msg.id, "flushed");
        continue;
      }
      log.debug("processing", { id: msg.id, channel: msg.channel });
      await _processOne(msg);
    }
  } catch (err) {
    log.error("drain loop error", { error: err.message });
  } finally {
    _running = false;
  }

  // Check if new messages arrived while we were processing
  const remaining = bus.stats().pending;
  if (remaining > 0) {
    setImmediate(() => _tick().catch(e => log.error("drain re-entry error", { error: e.message })));
  }
}

/**
 * Flush: fail all pending messages and abort current processing.
 */
export function flush() {
  app.queueAborted = true;
  // Discarded messages leave the queue shown above the input too.
  store.getState().clearQueuedInputs?.();
  // Cancel pending self-continue timer
  if (_continueTimer) {
    clearTimeout(_continueTimer);
    _continueTimer = null;
  }
  // Fail all pending bus messages
  let msg;
  while ((msg = bus.drain())) {
    bus.fail(msg.id, "flushed");
    const waiter = _drainResolvers.get(msg.id);
    if (waiter) {
      _drainResolvers.delete(msg.id);
      waiter.resolve({ error: "flushed" });
    }
  }
  // Reset abort flag after current lock chain settles
  setTimeout(() => { app.queueAborted = false; }, 0);
}

/**
 * Check if drain loop is currently processing.
 */
export function isProcessing() {
  return _running;
}
