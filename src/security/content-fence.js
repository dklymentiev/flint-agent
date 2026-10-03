// Content Gate — unified sanitizer for ALL tool results before entering agent context
// Handles: size limits, control chars, delimiter injection, secrets, prompt injection

import crypto from "node:crypto";
import { MAX_RESULT_BYTES } from "./safety-constants.js";

/**
 * Generate a unique session delimiter to replace the hardcoded <tool_result>.
 * Format: <tool_result_XXXXXXXXXXXX> where X is random hex.
 */
export function generateSessionDelimiter() {
  const suffix = crypto.randomBytes(6).toString("hex");
  return `tool_result_${suffix}`;
}

// ── Control Character Stripping ─────────────────────────────

// Zero-width chars, RTL/LTR overrides, other invisible manipulators
const CONTROL_CHAR_RE = /[\u200B-\u200F\u202A-\u202E\uFEFF\u00AD\u2060-\u2064\u2066-\u2069\u0000-\u0008\u000E-\u001F]/g;

export function stripControlChars(text) {
  return text.replace(CONTROL_CHAR_RE, "");
}

// ── Injection Detection ─────────────────────────────────────
//
// Detection approach: multi-pattern regex heuristics with categorization
// and severity scoring. Covers OWASP LLM Top 10 #1 (Prompt Injection).
//
// Categories:
//   instruction_override — attempts to replace/ignore system instructions
//   role_manipulation   — attempts to change the agent's identity/role
//   delimiter_injection — attempts to break message boundaries
//   safety_bypass       — attempts to disable safety/security features
//   data_exfil          — attempts to extract system prompt or secrets
//
// Severity: high (3), medium (2), low (1)
// Score >= 3 → high confidence injection
// Score 1-2  → suspicious, log but don't block

const INJECTION_RULES = [
  // instruction_override (high severity)
  { pattern: /\bignore\s+(all\s+)?previous\s+instructions?\b/i, category: "instruction_override", severity: 3 },
  { pattern: /\bnew\s+instructions?\s*:/i, category: "instruction_override", severity: 3 },
  { pattern: /\bforget\s+(everything|all|your)\b/i, category: "instruction_override", severity: 3 },
  { pattern: /\bdisregard\s+(all\s+)?(previous|above|prior)\b/i, category: "instruction_override", severity: 3 },
  { pattern: /\bdo\s+not\s+follow\s+(any|your|the)\s+(previous|original)\b/i, category: "instruction_override", severity: 3 },

  // role_manipulation (high severity)
  { pattern: /\byou\s+are\s+now\b/i, category: "role_manipulation", severity: 3 },
  { pattern: /\bACT\s+AS\b/i, category: "role_manipulation", severity: 2 },
  { pattern: /\bpretend\s+(you\s+are|to\s+be)\b/i, category: "role_manipulation", severity: 2 },
  { pattern: /\bDAN\s+mode\b/i, category: "role_manipulation", severity: 3 },
  { pattern: /\bjailbreak\b/i, category: "role_manipulation", severity: 3 },
  { pattern: /\brole\s*:\s*system\b/i, category: "role_manipulation", severity: 3 },
  { pattern: /\bsimulate\s+(being|a)\b/i, category: "role_manipulation", severity: 1 },
  { pattern: /\brespond\s+only\s+(in|as|like)\b/i, category: "role_manipulation", severity: 2 },
  { pattern: /\bfrom\s+now\s+on\s+you\s+are\b/i, category: "role_manipulation", severity: 3 },

  // delimiter_injection (high severity)
  { pattern: /<\/?system>/i, category: "delimiter_injection", severity: 3 },
  { pattern: /\bsystem\s*:\s*/i, category: "delimiter_injection", severity: 2 },
  { pattern: /\[INST\]/i, category: "delimiter_injection", severity: 3 },
  { pattern: /<<SYS>>/i, category: "delimiter_injection", severity: 3 },
  { pattern: /<\|im_start\|>/i, category: "delimiter_injection", severity: 3 },
  { pattern: /\bHuman\s*:\s*$/m, category: "delimiter_injection", severity: 2 },
  { pattern: /\bAssistant\s*:\s*$/m, category: "delimiter_injection", severity: 2 },

  // safety_bypass (high severity)
  { pattern: /\boverride\s+safety\b/i, category: "safety_bypass", severity: 3 },
  { pattern: /\bdisable\s+(all\s+)?filters?\b/i, category: "safety_bypass", severity: 3 },
  { pattern: /\bno\s+restrictions?\b/i, category: "safety_bypass", severity: 2 },
  { pattern: /\bwithout\s+(any\s+)?(restrictions?|limitations?|guardrails?)\b/i, category: "safety_bypass", severity: 2 },
  { pattern: /\bturn\s+off\s+(safety|content\s+filter|moderation)\b/i, category: "safety_bypass", severity: 3 },
  { pattern: /\bbypass\s+(content\s+)?(filter|policy|safety)\b/i, category: "safety_bypass", severity: 3 },

  // data_exfil (medium severity)
  { pattern: /\b(reveal|show|print|output|display)\s+(your\s+)?(system\s+prompt|instructions?|rules?)\b/i, category: "data_exfil", severity: 2 },
  { pattern: /\bwhat\s+(are|is)\s+your\s+(system\s+)?(prompt|instructions?)\b/i, category: "data_exfil", severity: 1 },
  { pattern: /\brepeat\s+(everything|all|the\s+text)\s+(above|before)\b/i, category: "data_exfil", severity: 2 },
];

// ── Leet-speak / Obfuscation Normalization ──────────────────

const LEET_MAP = {
  "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a",
  "$": "s", "!": "i", "|": "l",
};

const LEET_RE = /[013457@$!|]/g;

/**
 * Normalize text for injection detection: lowercase, leet-speak → ascii, unicode whitespace → space.
 */
export function normalizeForDetection(text) {
  return text
    .toLowerCase()
    // Normalize unicode whitespace to regular space
    .replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ")
    // Normalize leet-speak substitutions
    .replace(LEET_RE, (ch) => LEET_MAP[ch] || ch);
}

/**
 * Detect prompt injection patterns in text.
 * Returns structured result with all matched patterns, categories, and total severity score.
 * Applies leet-speak normalization before matching.
 * @param {string} text
 * @returns {{ detected: boolean, score: number, matches: Array<{ pattern: string, category: string, severity: number }> }}
 */
export function detectInjection(text) {
  if (!text || typeof text !== "string") return { detected: false, score: 0, matches: [] };

  // Check both original and normalized text
  const normalized = normalizeForDetection(text);
  const matches = [];
  let score = 0;

  for (const rule of INJECTION_RULES) {
    if (rule.pattern.test(text) || rule.pattern.test(normalized)) {
      matches.push({
        pattern: rule.pattern.source,
        category: rule.category,
        severity: rule.severity,
      });
      score += rule.severity;
    }
  }

  return {
    detected: matches.length > 0,
    score,
    matches,
  };
}

// Legacy compat: flat list for existing tests
const INJECTION_PATTERNS = INJECTION_RULES.map((r) => r.pattern);

// Tools whose output is the local disk or a local process. Injection is still
// detected and audited for these; it is not blocked. A command can fetch from
// the network, so this is a trust decision about the operator's machine, not
// a claim that the bytes are safe.
export const LOCAL_SOURCE_TOOLS = new Set([
  "read_file", "search_in_files", "list_directory", "glob",
  "run_command", "run_background_command", "peek_process",
]);

// ── Content Gate Hook ───────────────────────────────────────

/**
 * Create a Content Gate afterHook — the unified sanitizer for all tool outputs.
 * Pipeline: size gate → control chars → delimiter escape → secret redaction → injection scan
 *
 * @param {string} delimiter - Session-unique delimiter tag name
 * @param {object} policy - Security policy (for secretPatterns)
 * @param {object} [auditFns] - { auditLog } for logging events
 * @returns {Function} afterHook(name, args, result)
 */
export function createContentFenceHook(delimiter, policy, auditFns) {
  const auditLog = auditFns?.auditLog || (() => {});
  const blockInjections = process.env.NODE_ENV === "test" && process.env.FLINT_UNSAFE_TEST_MODE === "1"
    ? process.env.AGENT_CONTENT_GATE_BLOCK_INJECTIONS !== "false"
    : true;

  return function contentGateHook(name, args, result) {
    if (name === "think") return null;
    if (result == null) return null;
    if (typeof result === "object") return null; // don't touch image/table objects

    let text = String(result);
    let modified = false;

    // 1. Size gate — hard limit to prevent context flooding
    const byteLength = Buffer.byteLength(text, "utf-8");
    if (byteLength > MAX_RESULT_BYTES) {
      const truncated = Buffer.from(text, "utf-8").subarray(0, MAX_RESULT_BYTES).toString("utf-8");
      text = truncated + `\n\n[Content Gate: truncated from ${(byteLength / 1024 / 1024).toFixed(1)} MB to ${(MAX_RESULT_BYTES / 1024 / 1024).toFixed(1)} MB]`;
      modified = true;
      auditLog("CONTENT_TRUNCATED", name, args, {
        originalBytes: byteLength,
        maxBytes: MAX_RESULT_BYTES,
      });
    }

    // 2. Strip invisible/control characters (zero-width, RTL overrides, etc.)
    const cleaned = stripControlChars(text);
    if (cleaned !== text) {
      text = cleaned;
      modified = true;
      auditLog("CONTROL_CHARS_STRIPPED", name, args, {
        removedCount: text.length - cleaned.length,
      });
    }

    // 3. Escape tool_result delimiters in output to prevent delimiter injection
    const delimRe = /<\/?tool_result(\s|>|_)/gi;
    if (delimRe.test(text)) {
      text = text.replace(/<(\/?)tool_result/gi, "<$1tool_result_escaped");
      modified = true;
    }

    // Also escape the session-specific delimiter if it appears in output
    if (delimiter && text.includes(delimiter)) {
      text = text.replaceAll(delimiter, delimiter + "_escaped");
      modified = true;
    }

    // 4. Redact secrets
    if (policy.secretPatterns) {
      for (const pattern of policy.secretPatterns) {
        const re = new RegExp(pattern.source, pattern.flags);
        const matches = text.match(re);
        if (matches) {
          for (const match of matches) {
            const prefix = match.slice(0, Math.min(4, match.length));
            const replacement = prefix + "*".repeat(Math.min(match.length - 4, 20));
            text = text.replace(match, replacement);
            modified = true;
            auditLog("SECRET_REDACTED", name, args, {
              pattern: pattern.source.slice(0, 30),
              prefix,
            });
          }
        }
      }
    }

    // 5. Injection detection — log always, block high-confidence in blocking mode
    const injection = detectInjection(text);
    if (injection.detected) {
      auditLog("INJECTION_ATTEMPT", name, args, {
        score: injection.score,
        categories: [...new Set(injection.matches.map((m) => m.category))],
        snippet: text.slice(0, 100),
      });
      // Block any detected injection when blocking is enabled, on content
      // that came from outside. Local files and local commands are logged
      // but not blocked: an agent repairing its own code reads its own prompt
      // text, and on 2026-09-26 the gate blinded it to agent.js mid-repair.
      // Owner's decision: the gate is for the web, mail and MCP.
      if (blockInjections && injection.score >= 2 && !LOCAL_SOURCE_TOOLS.has(name)) {
        text = `[Content Gate: prompt injection detected (score ${injection.score}) in ${name} output — content blocked]`;
        modified = true;
      }
    }

    return modified ? text : null;
  };
}
