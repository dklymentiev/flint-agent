// Who decides which tools a turn gets, and when that decision is not trusted.
//
// The classifier runs BEFORE the agent has read the task, and its picks are a
// guess. On 2026-09-29 the guess took the tools away from the task three times
// in one evening and nobody was told:
//
//   "Read <brief> and do what it says"        -> file_read  (1 tool, 3 steps)
//   "so why did you stop"                     -> chat       (0 tools)
//   "Continue the task: write the fix and the
//    tests as files ..., run them with npx
//    vitest, commit."                         -> chat       (0 tools)
//
// The third one is the worst: a turn that arrives in the middle of work, or
// that points at a file holding the instructions, has by definition not
// described all the work. A class list and a one-sentence paraphrase are not
// enough to decide that read_file is all it needs, and no one was shown the
// narrowing.
//
// Two rules, both about trust rather than about wording:
//
//   1. A guess is never the whole reason a turn loses its tools. When the
//      message is mid-task (tools already ran in this session) or points at a
//      file with instructions, the turn gets the full built-in surface and the
//      classifier's class is kept only for display.
//   2. Whatever narrowing does happen is visible: the operator is told which
//      class it was and how many tools survived. A silent narrowing is what
//      makes a turn that could not be done look like a turn that gave up.
//
// Widening costs tokens — the fallback is every built-in tool, not the core
// set. That is the direction to pay in: a narrow turn that cannot do the task
// is worth more than the tokens it saved, and the price is only paid on the
// messages where the guess is known to be unsafe.

// What a message pointing at instructions usually looks like. Extensions only:
// a path with one of these is a thing someone wrote down, which is the whole
// reason the request cannot be read off its first line.
const INSTRUCTION_FILE = /[\w./\\-]*\.(?:md|markdown|txt|rst|adoc|brief|task|todo|instructions)\b/i;

// Phrases that hand the work to something outside the message itself.
const INSTRUCTION_PHRASES = [
  /\bdo (?:what|as) (?:it|this|the file|the brief) says\b/i,
  /\bas (?:it|the file|the brief) says\b/i,
  /\bfollow (?:the )?(?:instructions?|steps?|directions?) in\b/i,
  /\b(?:according to|per) the (?:instructions?|brief|file)\b/i,
  /\bsee (?:the )?file\b.*\bfor\b/i,
  /\bin (?:the|this) file\b/i,
];

/**
 * Does this message hand the work to something else — a file, a brief, a
 * list of instructions somewhere on disk?
 *
 * @param {string} text
 * @returns {null | {kind: "file"|"phrase", path?: string}} null when it does not
 */
export function pointsAtInstructions(text) {
  const s = String(text || "");
  if (!s.trim()) return null;
  const fileMatch = s.match(INSTRUCTION_FILE);
  if (fileMatch) return { kind: "file", path: fileMatch[0] };
  if (INSTRUCTION_PHRASES.some((re) => re.test(s))) return { kind: "phrase" };
  return null;
}

/**
 * Is this message arriving in the middle of work?
 *
 * `priorToolCalls` is the fact that matters, not the number of messages: if
 * this session already ran a tool, the operator is in the middle of a task,
 * and a bare message in the middle of a task is a continuation, not a new
 * subject. `priorTurns` is kept for the softer case — a second message with no
 * tool yet is usually a follow-up of the first ("why?").
 *
 * @param {object} ctx - { priorToolCalls?: boolean, priorTurns?: number }
 * @returns {boolean}
 */
export function isMidTask(ctx = {}) {
  if (ctx.priorToolCalls) return true;
  return (ctx.priorTurns || 0) > 0;
}

// Below this, a tool set cannot do a task that involves writing, running and
// checking anything — which is what a mid-task message almost always is.
const MIN_TRUSTWORTHY_TOOLS = 6;

/**
 * Is the classifier's tool set good enough to act on for this message?
 *
 * @param {object} args
 * @param {object} args.manifest   — the classifier's manifest
 * @param {string} args.message    — the user's message
 * @param {object} [args.ctx]      — { priorToolCalls, priorTurns }
 * @returns {null | {untrusted: true, reason: string}} null when the set is trusted
 */
export function untrustedToolSet({ manifest, message, ctx = {} }) {
  const picked = Array.isArray(manifest?.tools) ? manifest.tools.length : 0;
  const midTask = isMidTask(ctx);
  const pointer = pointsAtInstructions(message);

  if (pointer) {
    return {
      untrusted: true,
      reason: `the message points at instructions (${pointer.path || pointer.kind}), so the request is not in the message`,
    };
  }
  if (picked === 0 && midTask) {
    return { untrusted: true, reason: "a text-only class for a mid-task message" };
  }
  if (picked === 0 && pointer) {
    return { untrusted: true, reason: "a text-only class for a message that points at instructions" };
  }
  if (midTask && picked < MIN_TRUSTWORTHY_TOOLS) {
    return {
      untrusted: true,
      reason: `only ${picked} tool${picked === 1 ? "" : "s"} for a message that arrives mid-task`,
    };
  }
  return null;
}

/**
 * One line for the operator about what this turn can do.
 *
 * Returns "" when nothing was narrowed: a turn with every tool is the normal
 * case and a line about it would be noise on every message. When something
 * was narrowed, the class and the count are both stated, because the count is
 * the part that decides whether the task is possible.
 *
 * @param {object} args - { manifest, allDefs, tools }
 * @returns {string}
 */
export function describeToolScope({ manifest, allDefs = [], tools = [] } = {}) {
  if (!manifest) return "";
  const total = allDefs.length;
  const names = tools.map((t) => t.function?.name || t.name).filter(Boolean);
  if (!total) return "";
  // Full surface is the normal case and a line about it would be noise on every
  // message; anything else, including zero tools, is stated.
  if (names.length >= total) return "";
  const shown = names.slice(0, 8).join(", ");
  const more = names.length > 8 ? `, +${names.length - 8} more` : "";
  const list = names.length ? `(${shown}${more})` : "(none)";
  return `mode ${manifest.intent}: ${names.length} of ${total} tools ${list}`;
}

/**
 * The tool list this turn actually gets, and one line about it for the
 * operator.
 *
 * The assessment gate wins over everything: a `dangerous` classification is a
 * deliberate refusal to hand over the tools, and this module is not entitled
 * to overrule it. That is the difference between a guess that may be wrong
 * (the classifier's tool picks) and a decision that was made on purpose.
 *
 * The fallback shape is the built-in surface rather than every live tool, for
 * the same reason fallbackManifest uses it: MCP schemas cost 33k tokens a call
 * and the MCP tools can be fetched by tool_search when the turn finds it needs
 * them. Measured in src/agent/intent.js.
 *
 * @param {object} args
 * @param {object} args.manifest      — the classifier's manifest
 * @param {Array}  args.allDefs       — every live tool definition
 * @param {Array}  [args.narrowedTools] — what filterToolsByManifest returned
 * @param {boolean} [args.blockTools] — the assessment gate took the tools
 * @param {string} [args.message]     — the user's message
 * @param {object} [args.ctx]         — { priorToolCalls, priorTurns }
 * @returns {{tools: Array, note: string, widened: boolean}}
 */
export function decideToolScope({
  manifest,
  allDefs = [],
  narrowedTools = [],
  blockTools = false,
  message = "",
  ctx = {},
} = {}) {
  const defs = Array.isArray(allDefs) ? allDefs : [];
  const nameOf = (t) => t.function?.name || t.name;

  if (blockTools) {
    return { tools: [], note: describeToolScope({ manifest, allDefs: defs, tools: [] }), widened: false };
  }

  const trust = untrustedToolSet({ manifest, message, ctx });
  if (!trust) {
    return { tools: narrowedTools, note: describeToolScope({ manifest, allDefs: defs, tools: narrowedTools }), widened: false };
  }

  const builtin = defs.filter((t) => !String(nameOf(t) || "").startsWith("mcp_"));
  const widened = builtin.length > 0 ? builtin : defs;
  // The count is always stated, including when the widened set is every tool:
  // "all 13 tools" and "1 of 13 tools" are different facts to the operator, and
  // the whole point of this line is that the difference is no longer invisible.
  const names = widened.map(nameOf).filter(Boolean);
  const shown = names.slice(0, 8).join(", ");
  const more = names.length > 8 ? `, +${names.length - 8} more` : "";
  const scopeText = `mode ${manifest?.intent || "unknown"}: ${names.length} of ${defs.length} tools`;
  const note = `[${manifest?.intent || "unknown"}] ${scopeText}${shown ? ` (${shown}${more})` : ""}` +
    ` — the tools were widened: ${trust.reason}. Nothing is lost; if this turns out to be the wrong read, say so.`;
  return { tools: widened, note, widened: true };
}