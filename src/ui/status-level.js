// The security level, for the status bar.
//
// A level that is chosen and then invisible is a level the operator cannot
// check themselves against. The onboarding question is asked exactly once, so
// for the whole life of the install the only evidence of which posture Flint is
// running at is this string — and when something asks that ought not to, the
// first question is whether the level is set to a stranger value than they
// think. It is not printed in the output stream (that is the conversation), it
// is shown in the status bar, which is where the numbers live that get read
// without being read on purpose.

import { getOnboardingAnswer } from "../tools/permissions.js";

/** The level, for display. Null when nobody has chosen one. */
export function currentLevel() {
  return getOnboardingAnswer();
}

/**
 * The status-bar fragment naming the level.
 *
 * Says "not set" rather than defaulting silently. The spec's default level
 * applies until the question is answered, and that is the right behaviour to
 * have — but "the right behaviour" and "the operator chose this" are different
 * claims, and a status bar that reports a default as if it were a choice is
 * reporting something it does not know. Before the question is answered this
 * says so, and the user can go and answer it.
 *
 * No chalk, deliberately: the status bar composes its own colouring, and this
 * is a fragment rather than a line.
 */
export function formatStatusLevel() {
  const level = currentLevel();
  if (!level) return "care: not set (/allow-all or answer the question to choose)";
  return `care: ${level}`;
}
