// Pauses that grow, for the two failures that are not the model's fault.
//
// 1. The model answers with nothing, several times running. Every one of those
//    is billed (17 in one session). Today Flint gives up on the third and
//    asks the operator to type "continue", which is the operator doing the
//    waiting that the agent is built to do. A silent model is usually a
//    provider that is briefly overloaded, and it comes back on its own.
//
// 2. The provider refuses with a temporary error: a 429, or the 400 that an
//    overloaded OpenRouter backend sends with "rate-limited upstream" in the
//    body. Both say "not now", and both used to end the turn instantly.
//
// So: both get the same treatment — wait, and the pause grows. 30s, 1m, 2m.
// The operator sees a countdown rather than a frozen screen, because the
// difference between "waiting, and here is when" and "hung" is the only thing
// that lets somebody decide not to press Esc.

/** Empty answers in a row before the turn stops and says so. */
export const EMPTY_RETRY_LIMIT = 3;

/** Temporary provider refusals in a row before the turn stops and says so. */
export function tempErrorRetryLimit() {
  const v = parseInt(process.env.AGENT_TEMP_ERROR_RETRIES || "", 10);
  return Number.isFinite(v) && v > 0 ? v : 3;
}

/** First pause. Every later pause is this times two, capped at 2 minutes. */
export function backoffBaseMs() {
  const v = parseInt(process.env.AGENT_BACKOFF_MS || "", 10);
  return Number.isFinite(v) && v > 0 ? v : 30_000;
}

const MAX_PAUSE_MS = 120_000;

/**
 * The pause before attempt number `attempt` (1-based).
 *
 * Grows, caps, and is monotonic: attempt 3 waits as long as attempt 4 does
 * rather than going back down, because a model that has been silent longer is
 * not about to answer in 30 seconds.
 *
 * @param {number} attempt — 1-based
 * @param {number} [baseMs]
 * @returns {number} milliseconds
 */
export function backoffMs(attempt, baseMs = backoffBaseMs()) {
  const n = Math.max(1, attempt | 0);
  return Math.min(MAX_PAUSE_MS, baseMs * Math.pow(2, n - 1));
}

/** m:ss, the way a countdown is read. 45s is "0:45", not "45". */
export function formatCountdown(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** The line the operator watches while Flint waits. */
export function waitNotice(reason, msLeft) {
  return `${reason}, retrying in ${formatCountdown(msLeft)} (Esc to stop)`;
}

/**
 * Wait, counting down out loud.
 *
 * Resolves true when the whole pause elapsed, false when it was cut short by
 * the abort signal — the caller must not treat "aborted" as "waited", or a turn
 * that was stopped with Esc carries on talking to the provider.
 *
 * @param {number} ms
 * @param {object} opts - { signal, onTick(remainingMs), tickMs, reason }
 * @returns {Promise<boolean>}
 */
export function sleepWithCountdown(ms, { signal, onTick, tickMs = 1000, reason = "the model is not answering" } = {}) {
  if (!(ms > 0)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let left = ms;
    let done = false;
    const finish = (waitedAll) => {
      if (done) return;
      done = true;
      clearInterval(interval);
      signal?.removeEventListener?.("abort", onAbort);
      resolve(waitedAll);
    };
    const onAbort = () => finish(false);
    const interval = setInterval(() => {
      left -= tickMs;
      if (left <= 0) {
        onTick?.(0);
        finish(true);
        return;
      }
      onTick?.(left);
    }, tickMs);
    interval.unref?.();
    if (signal) {
      if (signal.aborted) { finish(false); return; }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    onTick?.(left);
  });
}

/**
 * Is this provider failure temporary — "not now" rather than "no"?
 *
 * The line that matters: a 400 with "rate-limited upstream" or "overloaded" in
 * the body is an overloaded backend, not a malformed request. Flint used to
 * treat a 400 as fatal in three places and to treat a 429 as fatal in the main
 * loop, and both end up as "Stopped: API error" with nothing done.
 *
 * What is NOT temporary, and must still stop immediately: a bad key (401/403),
 * an empty account (402), and our own budget refusal. Those need a human, and
 * waiting does not change them.
 *
 * @param {Error & {statusCode?: number, isRateLimit?: boolean}} err
 * @returns {boolean}
 */
export function isTemporaryProviderError(err) {
  if (!err) return false;
  if (err.isAuthError || err.isQuotaError || err.isBudgetError) return false;
  if (err.name === "AbortError" || err.isStall) return false;
  if (err.isRateLimit) return true;
  const status = err.statusCode;
  if (status === 408 || status === 409 || status === 429 || status === 529) return true;
  if (typeof status === "number" && status >= 500) return true;
  const body = String(err.message || "").toLowerCase();
  if (status === 400 || status === 422) {
    return /overload|rate[- ]?limit|upstream|try again|temporar|capacity|busy|no available|too many requests/.test(body);
  }
  return false;
}

/** How the failure is named in the countdown, so it is not a bare number. */
export function describeProviderError(err) {
  if (err?.isRateLimit) return `the provider rate-limited the call (429)`;
  const status = err?.statusCode;
  const body = String(err?.message || "");
  const kind = /overload|rate[- ]?limit|upstream/i.test(body) ? "it reported an overloaded upstream" : "it failed";
  return status ? `the provider answered ${status} and ${kind}` : `the provider ${kind}`;
}