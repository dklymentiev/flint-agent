// Mode registry — maps intent classes to behavioral modes.
//
// Each mode defines:
//   - promptAddition: behavioral rules injected into system prompt
//   - maxIterations: iteration budget override
//   - model: optional model override (e.g. use Sonnet for project, Flash for chat)
//
// Model override: set via AGENT_MODEL_<MODE> env var or mode.model field.
// If not set, uses session default (config.model).
//
// 22 intent classes → 12 modes (many-to-one mapping).

export const MODES = {
  conversation: {
    name: "conversation",
    intents: ["chat", "knowledge_qa", "reasoning"],
    model: null, // cheapest model OK — override via AGENT_MODEL_CONVERSATION
    promptAddition: `[MODE: conversation]
- Prefer responding in text without tools. Use tools only if the question requires checking live data.
- Keep responses concise. No preamble. No trailing offers.
- Match the user's language and register.`,
    maxIterations: 5,
  },

  quick_action: {
    name: "quick_action",
    intents: ["shell_command", "file_read"],
    promptAddition: `[MODE: quick_action]
- Execute in 1-3 tool calls. No planning phase needed.
- Show the result immediately. Minimal explanation.
- If the result is an error — report it clearly, suggest a fix.`,
    maxIterations: 5,
  },

  planning: {
    name: "planning",
    intents: ["task_create", "task_update", "task_view"],
    promptAddition: `[MODE: planning]
- Create or manage tasks/plans. Use task tools (create_plan, update_task, list_tasks).
- When user says "plan X" — produce a text plan (bullet list). Do NOT auto-execute it.
- Only create a formal plan (via create_plan tool) if user explicitly confirms.`,
    maxIterations: 5,
  },

  files: {
    name: "files",
    intents: ["file_write", "file_edit", "file_manage"],
    promptAddition: `[MODE: files]
- File operations: create, edit, move, copy, delete, search.
- Always verify the file exists before editing. Show relevant content after changes.
- For edits: read first, modify, write back. Show the diff or changed section.
- Respect scope: only touch files the user mentioned.`,
    maxIterations: 8,
  },

  project: {
    name: "project",
    intents: ["complex_multi"],
    promptAddition: `[MODE: project]
- Multi-step feature work, refactoring, or bug fixing.
- Plan before executing: list what you'll change and why.
- After changes: run tests if available. Report results.
- Commit-ready: changes should be minimal and focused.`,
    maxIterations: 30,
  },

  autonomous: {
    name: "autonomous",
    intents: [],
    promptAddition: `[MODE: autonomous]
- Long self-directed work. You have extended budget.
- Write intermediate progress reports every 5-10 iterations.
- Self-verify: when you think you're done, check once more.
- If stuck after 3 attempts on same approach — try a different strategy.`,
    maxIterations: 50,
  },

  research: {
    name: "research",
    intents: ["web_search", "web_fetch"],
    promptAddition: `[MODE: research]
- Gather information from web and local sources.
- Structure findings: summary first, then details.
- Cite sources when using web results.
- If multiple sources disagree — note the discrepancy.`,
    maxIterations: 10,
  },

  computer_use: {
    name: "computer_use",
    intents: ["desktop"],
    promptAddition: `[MODE: computer_use]
- Desktop GUI interaction via screenshot/click/type tools.
- MANDATORY workflow: screenshot → look (OCR) → click. Never click blind.
- Prefer keyboard shortcuts over mouse when possible.
- If Chrome is open: use Chrome semantics (page_read, page_map) before OCR.`,
    maxIterations: 20,
  },

  delegation: {
    name: "delegation",
    intents: ["agent_spawn"],
    promptAddition: `[MODE: delegation]
- Spawn child agents for parallel work.
- Give each agent a clear, specific task description.
- Wait for results. Aggregate and summarize for the user.
- Max 3 concurrent child agents unless user specifies more.`,
    maxIterations: 10,
  },

  secretary: {
    name: "secretary",
    intents: [],
    promptAddition: `[MODE: secretary]
- Communication tasks: email, messages, scheduling.
- Use formal tone for external communications.
- Always show draft before sending. Wait for user approval.
- Include all relevant context (who, what, when, where).`,
    maxIterations: 5,
  },

  monitoring: {
    name: "monitoring",
    intents: [],
    promptAddition: `[MODE: monitoring]
- Periodic checks and alerts.
- Run check → compare with previous state → report changes.
- Only alert on meaningful changes, not noise.
- Keep logs of what was checked and when.`,
    maxIterations: 5,
  },

  creative: {
    name: "creative",
    intents: ["creative_text"],
    promptAddition: `[MODE: creative]
- Content generation: writing, editing, formatting.
- Longer output is acceptable. Use markdown formatting.
- If user asks to save result to file — use write_file.`,
    maxIterations: 5,
  },
};

// Build reverse map: intent → mode
const _intentToMode = new Map();
for (const [modeName, mode] of Object.entries(MODES)) {
  for (const intent of mode.intents) {
    _intentToMode.set(intent, modeName);
  }
}

/**
 * Get mode config for a given intent class.
 * Falls back to "project" for unknown intents (safest default).
 * Resolves model: env AGENT_MODEL_<MODE> > mode.model > null (use session default).
 * @param {string} intentClass — from intent classifier
 * @returns {{ name, promptAddition, maxIterations, model }}
 */
export function getModeForIntent(intentClass) {
  const modeName = _intentToMode.get(intentClass) || "project";
  const mode = MODES[modeName];
  // Resolve model: env var takes priority
  const envKey = `AGENT_MODEL_${modeName.toUpperCase()}`;
  const resolvedModel = process.env[envKey] || mode.model || null;
  return { ...mode, model: resolvedModel };
}

/**
 * Get mode by name directly.
 * @param {string} modeName
 * @returns {object|null}
 */
export function getMode(modeName) {
  return MODES[modeName] || null;
}

/**
 * List all available modes (for /help or tool listing).
 * @returns {Array<{name, description}>}
 */
export function listModes() {
  return Object.values(MODES).map(m => ({
    name: m.name,
    intents: m.intents,
    maxIterations: m.maxIterations,
  }));
}
