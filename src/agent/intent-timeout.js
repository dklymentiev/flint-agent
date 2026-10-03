// The classifier's per-attempt budget.
//
// Item 10: operator-visibility.test.js failed on a loaded machine, and one of
// the causes was a hard 15 s wall-clock deadline inside the classifier call that
// no caller could see or control. Under load that deadline fired before the
// mocked response was processed, and `classifyIntent` — which catches its own
// errors — returned the all-tools fallback. Nothing said so, which is how a test
// came to depend on how busy the machine was: the code under the assertion
// quietly changed its mind, and a fallback is indistinguishable from a real
// classification in the output.
//
// Its own module rather than a line in intent.js, because intent.js pulls in
// the config, the API client and the tool manifest: importing it to test one
// arithmetic decision means paying for a network client and an env-dependent
// config load, and the failure mode of that is a test that cannot run in CI at
// all. This is a pure function of the environment and is tested as one.
//
// The project rule is no silent fallbacks — a required value that is absent
// throws at config load rather than becoming a default. An override gets the
// same treatment. A caller that sets INTENT_TIMEOUT_MS=0 and silently receives
// 15 s has the original problem in a new place: a budget that is not what was
// asked for, with nothing said about it.

/** The production default, in ms. */
export const DEFAULT_INTENT_TIMEOUT_MS = 15000;

/**
 * The per-attempt budget for a classifier call.
 *
 * @returns {number} milliseconds
 * @throws {Error} if INTENT_TIMEOUT_MS is set to something that is not a
 *   positive number of milliseconds
 */
export function intentTimeoutMs() {
  const raw = process.env.INTENT_TIMEOUT_MS;
  // Unset, or set to empty: the documented default. An empty value in a .env is
  // a real thing to find and it means "not set", not "zero".
  if (!raw) return DEFAULT_INTENT_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(
      `INTENT_TIMEOUT_MS must be a positive number of milliseconds, got: ${raw}`,
    );
  }
  return n;
}
