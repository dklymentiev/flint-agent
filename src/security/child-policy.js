// Child policy — beforeHook that enforces max agent spawn depth

import { MAX_AGENT_DEPTH } from "./safety-constants.js";

/**
 * Get current agent depth from environment variable.
 * Root agent = 0, first child = 1, etc.
 */
function getCurrentDepth() {
  const envDepth = process.env.AGENT_DEPTH;
  if (envDepth != null) {
    const n = parseInt(envDepth, 10);
    // Clamp to hardcoded max — env can't raise the ceiling
    return isNaN(n) ? 0 : Math.min(n, MAX_AGENT_DEPTH);
  }
  return 0;
}

/**
 * Create a child-policy beforeHook.
 * @param {object} policy - Security policy from policies.js
 * @returns {Function} beforeHook(name, args)
 */
export function createChildPolicyHook(policy) {
  // Policy can lower the max depth but never exceed the hardcoded constant
  const maxDepth = Math.min(policy.child?.maxDepth ?? MAX_AGENT_DEPTH, MAX_AGENT_DEPTH);
  const currentDepth = getCurrentDepth();

  return function childPolicyHook(name, args) {
    if (name !== "spawn_agent") return null;

    if (currentDepth >= maxDepth) {
      return {
        deny: true,
        reason: `max agent depth (${maxDepth}) reached — current depth is ${currentDepth}`,
      };
    }

    return null;
  };
}
