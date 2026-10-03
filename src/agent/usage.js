// Usage accounting: the one place that decides what an API call cost, and the
// one place that refuses the next one when the money is gone.
//
// WHY the refusal lives HERE and not at each ceiling: there were three
// guards reading three different numbers. agent.js priced the turn itself with
// the local formula below, and checked it AFTER the turn; the session total in
// the store was only topped up once the turn ended, so a ceiling consulted mid
// turn could not see what the classifier and the fact extractor had already
// spent; auto mode read a lagging delta of that same total. Three notebooks,
// and four modules spending outside all of them. It leaked twice in two days,
// in opposite directions.
//
// Now every call to the provider goes through src/api/client.js, and that door
// asks this module two questions in order: may I, and then here is what it
// cost. Nobody adds anything up, so nobody can forget to.
//
// WHY this exists: the cost was computed locally as
// promptTokens * pricing.prompt + completionTokens * pricing.completion.
// That is wrong by more than 2x on any model with prompt caching, because a
// cache read costs ~120x less than a miss ($0.0036/M vs $0.435/M on
// mimo-v2.5-pro), and the local table knows nothing about which tokens were
// read from cache. The number is what the "is this expensive?" decision is
// made on, so a wrong instrument is worse than none: on 2026-09-19 it led to
// the conclusion that caching was broken when it was working.
//
// OpenRouter already returns the exact charge in `usage.cost` on every call,
// streaming included, WITHOUT any request-body flag. So: take the provider's
// number when it is there, estimate only when it is not, and never let an
// estimate pass itself off as a fact.

import { createLogger } from "../logging/logger.js";

const log = createLogger("usage");

// Where the fallback rate card comes from when the provider reports no cost.
// Injected at startup (bootstrap.js) rather than imported, so this module stays
// free of the store and can be exercised on its own.
//
// It is the MAIN model's card, and a side call may run on a cheaper model, so
// what it produces is a ceiling, not a price. That is why it is reached only
// when `usage.cost` is absent, and why everything it touches comes back
// flagged `estimated`.
let pricingSource = () => null;

/** The model's context window in tokens, when the rate card knows it. */
export function contextWindow() {
  return pricingSource()?.contextLength || null;
}

export function setPricingSource(fn) {
  pricingSource = typeof fn === "function" ? fn : () => null;
}

// `facts` is not on wip/judge-4758: the branch instrumented the classifier and
// the extractor and missed memory/extract-facts.js, which agent.js fires on
// every user message. Keep it when merging the rest of that branch's work.
// `outcome` is the one question asked out of band: which of the three
// things happened on a turn that changed nothing. It is a model call like any
// other, so it has to show up in the bill, or the fix is invisible money.
export const USAGE_SOURCES = ["agent", "classifier", "judge", "extractor", "facts", "outcome", "swap"];

/**
 * Normalize a provider `usage` object into the fields we account on.
 * Understands the OpenAI/OpenRouter shape; the Anthropic adapter maps its
 * own field names into the same shape before returning.
 *
 * @returns {null | {promptTokens, completionTokens, cachedTokens, cacheWriteTokens, cost}}
 *   `cost` is null when the provider did not report one.
 */
export function readUsage(usage) {
  if (!usage) return null;
  const details = usage.prompt_tokens_details || {};
  return {
    promptTokens: usage.prompt_tokens || 0,
    completionTokens: usage.completion_tokens || 0,
    cachedTokens: details.cached_tokens || 0,
    cacheWriteTokens: details.cache_write_tokens || 0,
    cost: typeof usage.cost === "number" ? usage.cost : null,
  };
}

/**
 * What did this call cost, and do we actually know?
 *
 * Provider number wins. The fallback estimate still prices cached tokens at
 * the cache-read rate when the model publishes one, so it is at least the
 * right shape, but it is returned flagged, and every surface shows the flag.
 *
 * @returns {{cost: number, estimated: boolean}}
 */
export function priceUsage(u, pricing) {
  if (!u) return { cost: 0, estimated: false };
  if (u.cost != null) return { cost: u.cost, estimated: false };
  if (!pricing) return { cost: 0, estimated: true };

  // Cached tokens are included in prompt_tokens, so bill them once, cheaply.
  const uncached = Math.max(0, u.promptTokens - u.cachedTokens);
  const cacheRate = pricing.cacheRead != null ? pricing.cacheRead : pricing.prompt;
  const cost =
    uncached * pricing.prompt +
    u.cachedTokens * cacheRate +
    u.completionTokens * pricing.completion;
  return { cost, estimated: true };
}

function emptyEntry() {
  return {
    calls: 0,
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    cost: 0,
    estimated: false,
  };
}

function emptyLedger() {
  // Built FROM the list, not repeated by hand. Repeating it cost eleven model
  // calls: `outcome` was added to USAGE_SOURCES, the ledger was not touched,
  // and recordUsage dropped every one of them on the floor because the entry
  // did not exist. The list is the one place a source is declared.
  const ledger = {};
  for (const source of USAGE_SOURCES) {
    ledger[source] = emptyEntry();
  }
  return ledger;
}

// What has been spent since the last drain, by source. `agent` has a row like
// everything else: the main loop is not a special kind of money. Before, it
// was priced separately by agent.js with the local formula, which is how the
// per-turn ceiling ended up guarding a number that was wrong by more than 2x on
// a cached model.
let ledger = emptyLedger();

// The three running totals, in dollars. They are three WINDOWS onto the same
// stream of calls, not three tallies: every recorded call moves all three.
//
//   action   one turn. Reset by beginAction().
//   session  everything since the session was opened or resumed.
//   run      one autonomous run. Counted only while a run is open, because a
//            run's ceiling is its own budget, not the session's history.
//
// Draining the by-source ledger for display does NOT touch them. A total that
// resets when somebody looks at it is not a total.
let spend = { action: 0, session: 0, run: 0 };
let runOpen = false;
let runLimit = 0;

/** Thrown by the door instead of making the call. */
export class BudgetExceededError extends Error {
  constructor({ scope, spent, limit }) {
    super(`Budget exhausted (${scope}): $${spent.toFixed(4)} of $${limit.toFixed(2)}`);
    this.name = "BudgetExceededError";
    this.isBudgetError = true;
    this.scope = scope;
    this.spent = spent;
    this.limit = limit;
  }
}

/** @returns {{action: number, session: number, run: number}} dollars spent */
export function getSpend() {
  return { ...spend };
}

/** A new turn starts. The per-action ceiling counts from here. */
export function beginAction() {
  spend.action = 0;
}

/**
 * An autonomous run starts, with its own ceiling.
 * @param {number} limit dollars; 0 or less means no ceiling of its own
 */
export function beginRun(limit = 0) {
  spend.run = 0;
  runLimit = limit > 0 ? limit : 0;
  runOpen = true;
}

export function endRun() {
  runOpen = false;
  runLimit = 0;
}

/** Restore the session total when a saved session is reopened. */
export function seedSessionSpend(cost) {
  spend.session = typeof cost === "number" && cost > 0 ? cost : 0;
}

/** Start a fresh session: the session window goes back to zero, the run closes. */
export function resetSessionSpend() {
  spend = { action: 0, session: 0, run: 0 };
  endRun();
  ledger = emptyLedger();
}

/**
 * Which ceiling, if any, has already been reached. The per-action and session
 * ceilings are read from config by the caller (they can change mid-session via
 * /budget), the run ceiling belongs to the open run.
 *
 * A ceiling of 0 means unlimited, which is the default for both config values.
 *
 * @returns {null | {scope: "action"|"session"|"run", spent: number, limit: number}}
 */
export function overBudget({ perAction = 0, session = 0 } = {}) {
  if (perAction > 0 && spend.action >= perAction) {
    return { scope: "action", spent: spend.action, limit: perAction };
  }
  if (session > 0 && spend.session >= session) {
    return { scope: "session", spent: spend.session, limit: session };
  }
  if (runOpen && runLimit > 0 && spend.run >= runLimit) {
    return { scope: "run", spent: spend.run, limit: runLimit };
  }
  return null;
}

/** overBudget, but it refuses instead of reporting. Throws BudgetExceededError. */
export function assertWithinBudget(limits) {
  const over = overBudget(limits);
  if (over) {
    log.warn("budget refusal", over);
    throw new BudgetExceededError(over);
  }
}

/**
 * Record one call to the provider. Called by the door, by nobody else: a
 * caller that has to remember this is a caller that will forget.
 * Safe with a missing/!ok usage object.
 * @param {"agent"|"classifier"|"judge"|"extractor"|"facts"|"outcome"} source
 */
export function recordUsage(source, usage, pricing = null) {
  const entry = ledger[source];
  if (!entry) {
    // A source that is spent but not declared is money leaving with no row to
    // show it. Say so loudly instead of returning quietly, which is how the
    // `outcome` calls went missing in the first place.
    log.error("usage for an unknown source", { source, known: Object.keys(ledger) });
    return null;
  }
  const u = readUsage(usage);
  if (!u) {
    // The call happened and we cannot say what it cost. Saying nothing would
    // silently understate the session, so mark the whole source as estimated.
    entry.calls += 1;
    entry.estimated = true;
    return null;
  }
  const { cost, estimated } = priceUsage(u, pricing || pricingSource());
  entry.calls += 1;
  entry.promptTokens += u.promptTokens;
  entry.completionTokens += u.completionTokens;
  entry.cachedTokens += u.cachedTokens;
  entry.cacheWriteTokens += u.cacheWriteTokens;
  entry.cost += cost;
  if (estimated) entry.estimated = true;

  spend.action += cost;
  spend.session += cost;
  if (runOpen) spend.run += cost;

  log.debug("usage", { source, promptTokens: u.promptTokens, cached: u.cachedTokens, cost, estimated });
  return { ...u, cost, estimated };
}

/**
 * Take everything recorded since the last drain, for the surfaces that display
 * it. The running totals are deliberately left alone.
 */
export function drainUsage() {
  const drained = ledger;
  ledger = emptyLedger();
  return drained;
}

/** Sum of a by-source map, for the totals line. */
export function sumUsage(bySource) {
  const total = emptyEntry();
  for (const entry of Object.values(bySource || {})) {
    if (!entry) continue;
    total.calls += entry.calls || 0;
    total.promptTokens += entry.promptTokens || 0;
    total.completionTokens += entry.completionTokens || 0;
    total.cachedTokens += entry.cachedTokens || 0;
    total.cacheWriteTokens += entry.cacheWriteTokens || 0;
    total.cost += entry.cost || 0;
    if (entry.estimated) total.estimated = true;
  }
  return total;
}

export { emptyEntry };
