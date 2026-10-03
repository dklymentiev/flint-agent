/**
 * Flow Controller — unified flow state machine
 *
 * Merges: loop-detector.js + auto-continue logic from drain-loop.js
 * Owns all flow decisions: loop detection, plan state, continue/stop, learning triggers.
 *
 * Used by:
 *   - agent.js: checkLoop(), resetFlow()
 *   - drain-loop.js: shouldContinue()
 */

import { createLogger } from "../logging/logger.js";

const log = createLogger("flow");

// --- Configurable thresholds ---
export function getThresholds() { return { ...THRESHOLDS }; }
const THRESHOLDS = {
  textRepeat: parseInt(process.env.AGENT_LOOP_TEXT_REPEAT || "5", 10),
  toolRepeat: parseInt(process.env.AGENT_LOOP_TOOL_REPEAT || "5", 10),
  toolRepeatScreenshot: parseInt(process.env.AGENT_LOOP_TOOL_SCREENSHOT || "7", 10),
  toolRepeatCommand: parseInt(process.env.AGENT_LOOP_TOOL_COMMAND || "8", 10),
  desktopObservations: parseInt(process.env.AGENT_LOOP_DESKTOP_OBS || "8", 10),
  coordGridPx: parseInt(process.env.AGENT_LOOP_COORD_GRID || "50", 10),
  maxRetries: 3,
  maxPlanCompletions: 20,
  historySize: 12,
  textHistorySize: 5,
};

const NAV_KEYS = new Set(["tab", "shift+tab", "down", "up", "left", "right", "pagedown", "pageup", "home", "end"]);
const MAX_REPLANS = 3;

// --- State ---
let _recentTexts = [];
let _recentToolCalls = [];
let _consecutiveDesktopObs = 0;
let _replanCount = 0;
let _autoRetries = new Map();
let _planCompletions = 0;
let _userInterrupted = false; // set when user sends a message during auto-continue

// --- Loop Detection (from loop-detector.js) ---

function _fuzzyToolSig(name, args) {
  if (!args || typeof args !== "object") return name;
  if (name.includes("wait_stable") || name.includes("wait_change") || name === "run_background_command") {
    return name + ":skip:" + Date.now();
  }
  if (name.includes("key") && args.keys && NAV_KEYS.has(String(args.keys).toLowerCase())) {
    return name + ":nav:" + Date.now();
  }
  const key = {};
  for (const [k, v] of Object.entries(args)) {
    if (k === "x" || k === "y") {
      key[k] = Math.round(Number(v) / THRESHOLDS.coordGridPx) * THRESHOLDS.coordGridPx;
    } else if (k === "text" || k === "command") {
      key[k] = String(v).slice(0, 120);
    } else if (k === "desktop_id" || k === "action" || k === "keys" || k === "cell") {
      key[k] = v;
    } else {
      // Bug fix 2026-04-12: default was slice(0, 40), which collapsed all
      // nested paths like /tmp/flint-bench/l4-deep/003/level1/level2/... into
      // a single signature and caused the loop detector to hard-stop legitimate
      // sequential reads across 6 different deep files. 200 chars covers all
      // realistic paths and file identifiers without meaningful memory cost.
      key[k] = typeof v === "string" ? v.slice(0, 200) : v;
    }
  }
  return name + ":" + JSON.stringify(key);
}

function _buildLoopResult(type, count, detail) {
  _replanCount++;
  if (_replanCount > MAX_REPLANS) {
    return { type, count, action: "stop", message: `[Loop: ${detail} repeated ${count}x. Re-plan failed. Stopped.]` };
  }
  return { type, count, action: "replan", message: `[Loop: ${detail} repeated ${count}x. STOP. Create NEW plan with DIFFERENT strategy.]` };
}

export function checkTextLoop(text) {
  const clean = (text || "").trim().toLowerCase();
  if (clean.length === 0 || clean.length >= 100) return null;
  _recentTexts.push(clean);
  if (_recentTexts.length > THRESHOLDS.textHistorySize) _recentTexts.shift();
  if (_recentTexts.length >= THRESHOLDS.textRepeat) {
    const last = _recentTexts[_recentTexts.length - 1];
    const count = _recentTexts.filter(t => t === last).length;
    if (count >= THRESHOLDS.textRepeat) {
      log.warn("text-loop", { text: clean.slice(0, 60), count });
      return _buildLoopResult("text", count, text);
    }
  }
  return null;
}

export function checkToolLoop(toolName, args) {
  const sig = _fuzzyToolSig(toolName, args);
  _recentToolCalls.push(sig);
  if (_recentToolCalls.length > THRESHOLDS.historySize) _recentToolCalls.shift();
  const count = _recentToolCalls.filter(t => t === sig).length;
  const threshold = (toolName.includes("screenshot") || toolName.includes("look"))
    ? THRESHOLDS.toolRepeatScreenshot
    : (toolName === "run_command" || toolName.includes("shell"))
      ? THRESHOLDS.toolRepeatCommand
      : THRESHOLDS.toolRepeat;
  if (count >= threshold) {
    log.warn("tool-loop", { tool: toolName, count, sig });
    return _buildLoopResult("tool", count, toolName);
  }
  return null;
}

export function checkDesktopLoop(toolCalls) {
  const hasAction = toolCalls.some(tc => {
    const n = tc.function?.name || tc.name || "";
    if (!n.includes("desktop") && !n.includes("screenbox")) return true;
    return n.includes("type") || n.includes("batch") || n.includes("shell")
      || n.includes("chrome") || n.includes("manage") || n.includes("file");
  });
  if (!hasAction) _consecutiveDesktopObs++;
  else _consecutiveDesktopObs = 0;
  if (_consecutiveDesktopObs >= THRESHOLDS.desktopObservations) {
    log.warn("desktop-loop", { count: _consecutiveDesktopObs });
    const result = _buildLoopResult("desktop", _consecutiveDesktopObs, "desktop observations");
    _consecutiveDesktopObs = 0;
    return result;
  }
  return null;
}

export function resetDesktopOnMeaningfulText(text) {
  if ((text || "").toLowerCase().match(/\b(done|completed|finished|saved|created|failed|cannot|impossible)\b/)) {
    _consecutiveDesktopObs = 0;
  }
}

// --- What the provider's refusals mean ---
//
// Shared on purpose. There are two autonomous loops, /auto in agent/auto.js
// and the bus in bus/drain-loop.js, and they are accepted
// separately because they are different loops. What counts as a refusal must
// not be one of the things they can disagree about: a reason that is fatal on
// one door and survivable on the other is a hole with a door in front of it.
//
// NOTE for anyone moving these: the rate-limit COUNTER must not live in this
// module. resetFlow() runs at the top of every agent invocation
// (agent.js:248), so anything kept here is wiped once per turn and a counter
// of consecutive turns would never reach two.

/** The provider is not going to serve the next turn either. A human is needed. */
// "empty": the model answered with nothing three times running. Another
// autonomous turn would only buy more empty, billed answers.
export const FATAL_PROVIDER_REASONS = new Set(["auth", "quota", "error", "empty"]);

/** How many 429s in a row before a run treats the cap as a closed door. */
export const MAX_CONSECUTIVE_RATE_LIMITS = 3;

/** How long to wait out a 429 when the provider did not send retry-after. */
export const RATE_LIMIT_WAIT_MS = 20000;

/** One line per reason, for the human who has to decide what to do about it. */
export const STOP_REASON_TEXT = {
  auth: "the provider rejected the API key",
  quota: "the account is out of credits",
  error: "the provider failed three calls in a row",
  "rate-limit": "the provider kept rate limiting the run",
  empty: "the model answered with nothing three times in a row",
};

// --- Auto-Continue / Plan State (from drain-loop.js) ---

/**
 * Decide whether to continue after agent returns.
 * @param {object} opts - { stopReason, plan, isApiScoped, apiGoalId, apiVerified }
 * @returns {null | {action: "stop"|"continue"|"verify", message?: string, prompt?: string}}
 */
export function shouldContinue({ stopReason, plan, isApiScoped, apiGoalId }) {
  // User interrupt: any non-self-continue message during auto-continue pauses the plan.
  // The user typed something → they want control. Don't fight them with auto-Continue.
  // Clear via resetFlow() (/new) or setUserInterrupt(false) (/resume).
  if (_userInterrupted) {
    log.info("flow: user interrupted auto-continue, pausing");
    return { action: "stop", reason: "user_interrupt" };
  }

  const hasPending = plan && plan.tasks?.some(t => t.status === "pending" || t.status === "in_progress");

  // No plan + done = simple task complete
  if (!plan) {
    log.info("flow: no plan + %s = stop", stopReason);
    return { action: "stop" };
  }

  // Plan exists, all tasks done
  if (!hasPending) {
    _autoRetries.clear();
    _planCompletions++;

    // API scope: goal done = stop. Verification handled by agent loop's self-verify gate.
    if (isApiScoped && plan?.goalId === apiGoalId) {
      log.info("flow: API goal complete, stopping", { goalId: plan.goalId });
      return { action: "stop", goalComplete: true };
    }

    // Safety limit
    if (_planCompletions >= THRESHOLDS.maxPlanCompletions) {
      _planCompletions = 0;
      log.warn("flow: max plan completions reached");
      return { action: "stop" };
    }

    // TUI: check other goals
    return {
      action: "continue",
      prompt: "Your plan is complete. Check if your original task has more work. If everything is truly done, write a summary and stop.",
    };
  }

  // Plan has pending tasks — find next
  const pending = plan.tasks.filter(t => t.status === "pending" || t.status === "in_progress");
  let nextTask = null;
  for (const t of pending) {
    const retries = _autoRetries.get(t.id) || 0;
    if (retries < THRESHOLDS.maxRetries) {
      nextTask = t;
      break;
    }
  }

  if (!nextTask) {
    _autoRetries.clear();
    return {
      action: "continue",
      prompt: "All remaining tasks exhausted retries. Mark them as skipped and move to the next phase.",
    };
  }

  const retries = _autoRetries.get(nextTask.id) || 0;
  _autoRetries.set(nextTask.id, retries + 1);

  const retryNote = retries > 0
    ? ` (retry ${retries}/${THRESHOLDS.maxRetries} — try a DIFFERENT approach. If blocked, add an alternative task via add_task and skip this one.)`
    : "";
  return {
    action: "continue",
    prompt: `Continue: "${nextTask.title}" [#${nextTask.id}]${retryNote}. Use update_task to mark progress.`,
  };
}

// --- Learning Trigger ---

/**
 * Check if current state is a learning opportunity.
 * Called by Verification Gate after successful task completion.
 * @returns {boolean}
 */
export function isLearningOpportunity({ plan, toolCallCount }) {
  // Multi-step task completed successfully = learning opportunity
  if (plan && plan.tasks?.length >= 2) return true;
  // Many tool calls = complex task worth learning from
  if (toolCallCount > 5) return true;
  return false;
}

// --- Reset ---

/**
 * Set/clear user interrupt flag. Called from drain-loop when a user
 * (non-self-continue) message arrives during an active plan.
 */
export function setUserInterrupt(interrupted) {
  if (_userInterrupted !== interrupted) {
    log.info("flow: user-interrupt", { interrupted });
  }
  _userInterrupted = interrupted;
}

export function isUserInterrupted() {
  return _userInterrupted;
}

/**
 * Per-turn reset: the loop detectors only. Called at the top of every agent
 * invocation.
 *
 * It used to be resetFlow(), which also cleared the run-level state below.
 * That ran once per turn, so the user interrupt the drain loop had just set
 * was gone before shouldContinue could read it, the per-task retry cap never
 * got past one, and the plan-completion cap never got past one either.
 */
export function resetTurn() {
  _recentTexts = [];
  _recentToolCalls = [];
  _consecutiveDesktopObs = 0;
  _replanCount = 0;
}

/**
 * Full reset: the loop detectors plus the run-level state (retries, plan
 * completions, user interrupt). For the start of a new run and /new.
 */
export function resetFlow() {
  resetTurn();
  _autoRetries.clear();
  _planCompletions = 0;
  _userInterrupted = false;
}

