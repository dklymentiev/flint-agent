// Autonomous mode for Flint
// Wraps processMessage in a plan-driven loop
// Tasks persist in SQLite — can resume across sessions

import chalk from "chalk";
import { getActiveGoal, getTasksByGoal, getTaskStats } from "../tasks/queries.js";
import { syncPlanToStore } from "../tasks/queries.js";
import path from "node:path";
import { setDeniedPaths, clearDeniedPaths } from "../tools/filesystem.js";
import { beginRun, endRun } from "./usage.js";
import { config } from "../config.js";
import {
  FATAL_PROVIDER_REASONS,
  MAX_CONSECUTIVE_RATE_LIMITS,
  RATE_LIMIT_WAIT_MS,
  STOP_REASON_TEXT,
} from "./flow-controller.js";

const AUTO_SYSTEM_INJECTION = `
You are in AUTONOMOUS MODE. You are working on a task independently.

Rules:
1. You MUST create a plan (create_plan tool) as your FIRST action if no plan exists
2. Work through the plan step by step — focus on ONE task at a time
3. After completing each step, call update_task with status "done"
4. Verify your work after each step (read files you wrote, run tests, check output)
5. If stuck on a step after 2 attempts, REVISE the plan:
   - If the step can be done differently, use add_task to create an alternative step, then skip the stuck one
   - If later steps depend on the stuck step, reorder or skip them too
   - Use add_task_note to explain why the original step failed and what alternative you chose
   - Only mark a step "skipped" as last resort after trying an alternative
6. When all steps are done, provide a final summary of what was accomplished
7. Do NOT ask the user questions — make reasonable decisions yourself
8. If a step requires information you don't have, skip it and note why in the result
9. Use link_task_file to link files you create or modify to the relevant task
10. Use add_task_note for important observations during work
`.trim();

const CONTINUE_PROMPT = "Continue with the next pending task in the plan. Check the plan status (list_tasks) and work on the next 'pending' task.";

const PLAN_REMINDER = "You MUST create a plan first using the create_plan tool. Break the task into concrete steps, then execute them one by one.";

const BUDGET_WARNING_70 = "[BUDGET WARNING: You have used 70% of your iteration budget. Start wrapping up — finish the current task, skip non-essential remaining tasks, prepare a summary.]";

const BUDGET_WARNING_90 = "[BUDGET CRITICAL: 90% of iterations used. STOP after this step. Provide a final summary of what was accomplished and what remains.]";

const FINISH_PROMPT = "All tasks in the plan are complete (or skipped). Provide a final summary: what was accomplished, what was skipped and why, and any next steps the user should know about.";

const RESUME_PROMPT = `You are RESUMING autonomous work on an existing plan from a previous session.
The plan and task statuses are loaded from the database.
Review the current plan status (list_tasks) and continue with the next pending task.`;

// What the provider's refusals mean lives in flow-controller.js, shared with
// the bus loop so the two autonomous doors cannot disagree about which
// reasons are fatal. A 429 is not one of them: it says not now, rather than not
// ever, and a run left going overnight has to survive a per-minute cap.

/**
 * Run autonomous mode
 *
 * @param {string} task - The user's task description (or null to resume existing)
 * @param {object} options
 * @param {Function} options.processMessage - The main processMessage function
 * @param {Function} options.getStore - Returns the store
 * @param {Function} options.printSystem - Print system messages
 * @param {Function} options.printWarning - Print warnings
 * @param {number} options.maxIterations - Max auto iterations (default 50)
 * @param {number} options.maxCost - Max cost in dollars (default 0.50)
 * @param {Function} options.isAborted - Check if aborted
 * @param {boolean} options.resume - True if resuming existing plan
 * @param {Function} options.wait - Sleep for n ms; injected so a test can read
 *   the decision (how long the run chose to wait out a 429) without serving it
 * @returns {object} { completed, tasksTotal, tasksDone, tasksSkipped, totalCost, iterations, stopReason, stopDetail }
 */
export async function runAutoMode(task, options) {
  const {
    processMessage,
    getStore,
    printSystem,
    printWarning,
    maxIterations = 50,
    maxCost = 0.50,
    isAborted,
    resume = false,
    wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = options;

  const store = getStore();

  // Sandbox: block access to Flint's own source + permissions during auto mode
  const permFile = path.resolve(config.projectRoot, ".permissions.json");
  setDeniedPaths([config.projectRoot, permFile]);
  printSystem(`[AUTO] Sandbox: ${config.projectRoot} is protected`);

  // Sync SQLite → store at start
  syncPlanToStore(store);

  let iteration = 0;
  // This run's ceiling, declared to the door as well. The door refuses a call
  // the moment the run's budget is gone, which closes the gap this loop cannot
  // see: between two of its checks a single turn can make dozens of calls.
  beginRun(maxCost);
  // What this run has spent, read from the one place that publishes it: the
  // session total the message handler keeps, which is the drained ledger and
  // nothing else. Auto mode used to add up `stats.cost` from each turn it
  // happened to look at, which is the main loop's share only — the classifier,
  // the extractor and the three final messages whose result is discarded all
  // spent outside that sum. A run asked for a $1 ceiling went to $2.80.
  //
  // Deliberately the published total and not the ledger's own counter: this
  // loop runs BETWEEN turns, where the two agree, and reading what the
  // operator is shown means the number in the banner and the number the run
  // stops on can never be two different numbers.
  //
  // A delta, not the absolute total: `maxCost` is this run's budget, and the
  // session may already have spent money before /auto was typed.
  const costAtStart = store.getState().sessionCost || 0;
  const spentSoFar = () => (store.getState().sessionCost || 0) - costAtStart;
  let totalCost = 0;
  let planCreated = false;
  let planReminderSent = false;
  let finished = false;
  // Why the provider ended the run, if it did. Null means the run ended on its
  // own terms: plan finished, budget spent, operator aborted.
  let stopReason = null;
  let stopDetail = null;
  let rateLimitedInARow = 0;

  /**
   * One turn, and the only place this function talks to the agent.
   *
   * There used to be four such places, and two separate benchmark runs
   * patched three of them and left the one inside the loop, which is the one a
   * long run spends all its time in. One door cannot be half-closed.
   */
  async function turn(message) {
    for (;;) {
      const r = await processMessage(message, null);
      const reason = r?.stop_reason;

      if (reason === "rate-limit") {
        rateLimitedInARow++;
        if (rateLimitedInARow > MAX_CONSECUTIVE_RATE_LIMITS || isAborted?.()) {
          stopReason = "rate-limit";
          stopDetail = r?.text || "";
          return r;
        }
        // The provider's own number when it sent one, a fixed pause when it did
        // not. Retrying the same turn, so it is not counted as an iteration:
        // nothing was done and nothing was spent.
        const waitMs = r?.retryAfter != null ? r.retryAfter * 1000 : RATE_LIMIT_WAIT_MS;
        printWarning(
          `[AUTO] Rate limited by the provider. Waiting ${Math.round(waitMs / 1000)}s, ` +
          `then retrying (${rateLimitedInARow} of ${MAX_CONSECUTIVE_RATE_LIMITS}).`,
        );
        await wait(waitMs);
        continue;
      }

      rateLimitedInARow = 0;
      if (FATAL_PROVIDER_REASONS.has(reason)) {
        stopReason = reason;
        stopDetail = r?.text || "";
      }
      return r;
    }
  }

  // Check for existing active goal
  const existingGoal = getActiveGoal();

  if (resume && existingGoal) {
    const stats = getTaskStats(existingGoal.id);
    printSystem(`[AUTO] Resuming: ${existingGoal.title} (${stats.done}/${stats.total} done, ${stats.pending} pending)`);
    printSystem(`[AUTO] Budget: ${maxIterations} iterations, $${maxCost.toFixed(2)} max cost`);
    planCreated = true;

    // First message: resume context
    await turn(`${AUTO_SYSTEM_INJECTION}\n\n${RESUME_PROMPT}\n\nOriginal task: ${existingGoal.title}`);
    iteration++;
    totalCost = spentSoFar();
    updateAutoStatus(store, iteration, maxIterations, totalCost);
  } else {
    printSystem(`[AUTO] Starting: ${task}`);
    printSystem(`[AUTO] Budget: ${maxIterations} iterations, $${maxCost.toFixed(2)} max cost`);

    // First message: the task itself with auto mode instructions
    await turn(`${AUTO_SYSTEM_INJECTION}\n\nTask: ${task}`);
    iteration++;
    totalCost = spentSoFar();
    updateAutoStatus(store, iteration, maxIterations, totalCost);
  }

  try {
    // Main auto loop. `stopReason` ends it the moment the provider says the
    // next turn is pointless, including when it said so on the opening turn
    // above, before the loop was ever entered.
    while (!finished && !stopReason) {
      if (isAborted?.()) {
        printWarning("[AUTO] Aborted by user");
        break;
      }

      if (iteration >= maxIterations) {
        printWarning(`[AUTO] Iteration limit reached (${maxIterations})`);
        await processMessage(
          "[BUDGET EXHAUSTED] You have reached the maximum number of iterations. Provide a final summary of what was accomplished and what remains.",
          null,
        );
        break;
      }

      if (totalCost >= maxCost) {
        // No closing turn here, unlike the iteration limit above. That turn was
        // a model call, and the ceiling it would be paid over is the one just
        // reached: buying a summary to be told the budget is gone is the same
        // overshoot this rule prevents, and the budget door now refuses it
        // anyway. The run's own summary below says what was done. Iterations
        // are not money, so that limit still gets its wrap-up turn.
        printWarning(`[AUTO] Cost limit reached ($${totalCost.toFixed(4)} >= $${maxCost.toFixed(2)}). No closing turn: it would be spent over the ceiling.`);
        break;
      }

      // Sync from SQLite
      const plan = syncPlanToStore(store);

      if (!plan) {
        if (!planReminderSent) {
          planReminderSent = true;
          await turn(PLAN_REMINDER);
          iteration++;
          totalCost = spentSoFar();
          updateAutoStatus(store, iteration, maxIterations, totalCost);
          if (stopReason) break;
          continue;
        } else {
          printWarning("[AUTO] Agent did not create a plan. Stopping.");
          break;
        }
      }

      if (!planCreated) {
        planCreated = true;
        printSystem(`[AUTO] Plan created: ${plan.goal} (${plan.tasks.length} tasks)`);
      }

      // Check plan progress from SQLite
      const pending = plan.tasks.filter((t) => t.status === "pending");
      const inProgress = plan.tasks.filter((t) => t.status === "in_progress");
      const done = plan.tasks.filter((t) => t.status === "done");
      const skipped = plan.tasks.filter((t) => t.status === "skipped");

      if (pending.length === 0 && inProgress.length === 0) {
        printSystem(`[AUTO] All tasks completed (${done.length} done, ${skipped.length} skipped)`);
        await processMessage(FINISH_PROMPT, null);
        iteration++;
        finished = true;
        break;
      }

      // Budget warning
      let budgetWarning = "";
      const progress = iteration / maxIterations;
      if (progress >= 0.9) {
        budgetWarning = "\n\n" + BUDGET_WARNING_90;
      } else if (progress >= 0.7) {
        budgetWarning = "\n\n" + BUDGET_WARNING_70;
      }

      const continueMsg = CONTINUE_PROMPT + budgetWarning;
      await turn(continueMsg);
      iteration++;
      totalCost = spentSoFar();

      updateAutoStatus(store, iteration, maxIterations, totalCost);
    }
  } catch (err) {
    clearDeniedPaths();
    if (err.name === "AbortError") {
      printWarning("[AUTO] Aborted");
    } else {
      printWarning(`[AUTO] Error: ${err.message}`);
    }
  }

  // Final stats from SQLite
  const finalPlan = syncPlanToStore(store);
  // Read once more: the three messages that end a run, the iteration limit, the cost
  // limit and the final summary, throw their result away, so their cost never reached
  // the old counter and the figure the operator was shown was short by a turn
  // or two of every finished run.
  totalCost = spentSoFar();
  // The run window closes here, and with it its ceiling. Anything the operator
  // does afterwards is bounded by the per-action and session ceilings, not by
  // the budget of a run that has ended.
  endRun();
  const stats = {
    completed: finished,
    iterations: iteration,
    totalCost,
    tasksTotal: finalPlan ? finalPlan.tasks.length : 0,
    tasksDone: finalPlan ? finalPlan.tasks.filter((t) => t.status === "done").length : 0,
    tasksSkipped: finalPlan ? finalPlan.tasks.filter((t) => t.status === "skipped").length : 0,
    // Null unless the provider ended the run. Callers that only counted
    // iterations reported "50 iterations, not done" for a run that actually
    // stopped on turn five with an expired key.
    stopReason,
    stopDetail,
  };

  // Remove sandbox
  clearDeniedPaths();

  if (stopReason) {
    printWarning(
      `[AUTO] Stopped on iteration ${iteration} of ${maxIterations}: ` +
      `${STOP_REASON_TEXT[stopReason] || stopReason} (${stopReason}). ` +
      `${stats.tasksDone}/${stats.tasksTotal} tasks done, $${totalCost.toFixed(4)} spent.`,
    );
    if (stopDetail) printSystem(`[AUTO] Provider said: ${stopDetail}`);
  } else {
    printSystem(
      `[AUTO] Finished: ${stats.tasksDone}/${stats.tasksTotal} tasks done, ` +
      `${stats.tasksSkipped} skipped, ${iteration} iterations, $${totalCost.toFixed(4)}`,
    );
  }

  store.setState({ autoMode: null });
  return stats;
}

function updateAutoStatus(store, iteration, maxIterations, cost) {
  const plan = store.getState().plan;
  const tasksDone = plan ? plan.tasks.filter((t) => t.status === "done").length : 0;
  const tasksTotal = plan ? plan.tasks.length : 0;

  store.setState({
    autoMode: {
      iteration,
      maxIterations,
      cost,
      tasksDone,
      tasksTotal,
    },
  });
}
