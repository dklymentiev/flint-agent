// Security module entry point — orchestrates all security hooks and services

import { loadPolicy, dangerousPatternsThatAsk, DEFAULT_ONBOARDING_LEVEL } from "./policies.js";
import { createPathGuardHook } from "./path-guard.js";
import { createContentFenceHook, generateSessionDelimiter } from "./content-fence.js";
import { createCommandGuardHook } from "./command-guard.js";
import { createNetworkGuardHook } from "./network-guard.js";
import { masterTokenIfEnabled, createAuthMiddleware } from "./api-auth.js";
import { initAudit, auditLog, createAuditBeforeHook, createAuditAfterHook } from "./audit.js";
import { startWatchdog } from "./watchdog.js";
import { ALLOW_SECURITY_DISABLE } from "./safety-constants.js";
import { createChildPolicyHook } from "./child-policy.js";
import { addBeforeHook, addAfterHook, getOnboardingAnswer } from "../tools/permissions.js";
import { getCommandApproval } from "../tools/command-approvals.js";

let securityApi = null;

/**
 * The level used until the onboarding question has been answered.
 *
 * Now DEFAULT_ONBOARDING_LEVEL from policies.js, next to LEVELS and
 * levelOptions(). It used to be a second copy of "normal" living in this file,
 * which meant the guard and the first-run menu each named the default on their
 * own and nothing checked that they still named the same one.
 */
const DEFAULT_LEVEL = DEFAULT_ONBOARDING_LEVEL;

/**
 * Initialize the security module.
 * Registers hooks, starts watchdog, generates API token.
 *
 * @param {object} store - Zustand store
 * @param {object} config - App config
 * @returns {object} securityApi — { token, delimiter, authMiddleware, stopWatchdog, policy }
 */
export function initSecurity(store, config) {
  // Opt-out via env var — only allowed in test mode
  if (process.env.AGENT_SECURITY_DISABLE === "1" && ALLOW_SECURITY_DISABLE) {
    securityApi = {
      token: null,
      delimiter: null,
      authMiddleware: null,
      stopWatchdog: () => {},
      policy: null,
      disabled: true,
    };
    return securityApi;
  }

  try {
    // Load policy
    const policy = loadPolicy(config);

    // Initialize audit logging
    initAudit(config);

    // Generate session-unique delimiter for content fencing
    const delimiter = generateSessionDelimiter();

    // The token-file key only with FLINT_API_TOKEN_FILE=1; otherwise null and
    // programs get into the HTTP API by pairing (see masterTokenIfEnabled).
    const token = masterTokenIfEnabled();
    const authMiddleware = createAuthMiddleware(token);

    // Register beforeHooks in order:
    // 1. path-guard — blocks access to critical paths
    addBeforeHook(createPathGuardHook(policy));

    // 2. command-guard — blocks dangerous shell commands
    //
    // The patterns that ASK are the ones the chosen level names, not the ones
    // the loaded profile carries. Those are two different axes that happen to
    // share a word: loadPolicy keys on the security profile
    // (strict/normal/permissive) while the onboarding question asks about the
    // level (safe/normal/permissive). Wiring the guard to the profile meant the
    // answer the operator gave had no effect on any command — the level
    // decided prompts in tests and decided nothing in the app, which is exactly
    // the shape of bug a suite full of direct unit calls cannot see.
    //
    // Unanswered falls back to normal, the documented default. Stated here
    // rather than left implicit, because a guard handed no patterns at all is a
    // guard that has silently stopped guarding.
    // Read per call, not once at boot, so /careful takes effect at once.
    const guardPolicy = { ...policy };
    Object.defineProperty(guardPolicy, "dangerousCommandPatterns", {
      enumerable: true,
      get: () => dangerousPatternsThatAsk(getOnboardingAnswer() || DEFAULT_LEVEL),
    });
    addBeforeHook(createCommandGuardHook(Object.assign(guardPolicy, {
      // The guard asks this rather than importing it, so the guard stays a pure
      // function of (policy, command) and the file that owns persistence stays
      // replaceable in a test.
      // Named explicitly, not by shorthand: the policy field is called
      // readCommandApproval and the function is called getCommandApproval, and
      // a shorthand here made it a reference to an undefined binding — which
      // initSecurity caught and turned into process.exit(78) at boot.
      readCommandApproval: getCommandApproval,
    })));

    // 3. network-guard — blocks private IPs, rate limits
    addBeforeHook(createNetworkGuardHook(policy, config.port));

    // 4. child-policy — enforces max agent depth
    addBeforeHook(createChildPolicyHook(policy));

    // 5. audit before hook — logs all tool calls (last, so it logs even if others deny)
    addBeforeHook(createAuditBeforeHook());

    // Register afterHooks:
    // 1. content-fence — escapes delimiters, redacts secrets, detects injections
    addAfterHook(createContentFenceHook(delimiter, policy, { auditLog }));

    // 2. audit after hook — logs tool results
    addAfterHook(createAuditAfterHook());

    // Start watchdog
    const stopWatchdog = startWatchdog(store, config, { auditLog });

    securityApi = {
      token,
      delimiter,
      authMiddleware,
      stopWatchdog,
      policy,
      disabled: false,
    };

    return securityApi;
  } catch (err) {
    // SECURITY: Never silently degrade — fail hard if security can't init
    console.error(`[CRITICAL] Security init failed: ${err.message}`);
    console.error("[CRITICAL] Agent cannot run without security hooks. Exiting.");
    process.exit(78); // EX_CONFIG — configuration error
  }
}

/**
 * Get the cached security API (after initSecurity has been called).
 * @returns {object|null} securityApi
 */
export function getSecurityApi() {
  return securityApi;
}
