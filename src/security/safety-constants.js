// Hardcoded safety constants — NEVER overridable via config or env vars.
// These are the absolute minimum safety guarantees of the system.
// Changing these requires a code change and code review.

// Max tool result size in bytes (1 MB) — prevents context flooding
export const MAX_RESULT_BYTES = 1_048_576;

// Max agent spawn depth — prevents recursive agent chain attacks
export const MAX_AGENT_DEPTH = 5;

// Max content length for memory entries
export const MAX_MEMORY_CONTENT = 10_000;

// HMAC algorithm — always SHA-256
export const HMAC_ALGORITHM = "sha256";

// HMAC key length in bytes
export const HMAC_KEY_BYTES = 32;

// Security module cannot be disabled in production
export const ALLOW_SECURITY_DISABLE = process.env.NODE_ENV === "test";

// Minimum security policy — can't go below "normal" in production
export const MIN_SECURITY_POLICY = "normal";

// These injection patterns are always checked, regardless of config
export const CORE_INJECTION_PATTERNS = [
  /\bignore\s+(all\s+)?previous\s+instructions?\b/i,
  /\byou\s+are\s+now\b.*\bassistant\b/i,
  /\bforget\s+(everything|all)\b/i,
  /<\/?system>/i,
  /\bjailbreak\b/i,
  /\boverride\s+safety\b/i,
];
