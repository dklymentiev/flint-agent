// Intent manifest — catalog of intent classes.
//
// Each intent describes a *class of request* — how many steps it usually needs,
// what the output looks like, and whether tools are required at all. Tool
// selection itself is delegated to the classifier at runtime, which picks
// concrete tools from the live registry. This keeps the manifest agnostic to
// specific tool names — adding a new tool in registry does not require editing
// this file.
//
// Fields:
//   description   — one-line hint for the classifier prompt
//   needsTools    — false = pure text/knowledge answer (empty tool list enforced)
//                   true  = classifier will pick tools from the live registry
//   max_steps     — hard cap on iterations for this intent
//   expected      — shape of final output: "text" | "tool_call" | "tool_and_summary" | "mixed"
//   changes       : does a request of this class end with something different
//                   on disk? "yes" when that is the whole point of the class,
//                   "no" when it is a question, "maybe" when the class covers
//                   both. The no-change check uses it to decide whether a turn that changed
//                   nothing owes the operator an explanation. It is a property
//                   of the CLASS, written down once where the classes are
//                   described and reviewable there, not a guess about the
//                   wording of any one request.

export const INTENTS = {
  // --- Pure text: model answers from own knowledge, no tools at all ---
  creative_text: {
    description: "Generate text from scratch and reply in chat: poems, stories, summaries, explanations, jokes, translations, code snippets (no execution). DO NOT pick this if the user asks to SAVE/WRITE the result to a file or path — that is file_write.",
    needsTools: false,
    max_steps: 1,
    changes: "no",
    expected: "text",
  },

  knowledge_qa: {
    description: "Factual question, definition, or explanation that the model can answer directly without tools",
    needsTools: false,
    max_steps: 1,
    changes: "no",
    expected: "text",
  },

  reasoning: {
    description: "Math, logic, puzzles, analysis of data provided in the message itself",
    needsTools: false,
    max_steps: 2,
    changes: "no",
    expected: "text",
  },

  chat: {
    description: "Small talk, greetings, acknowledgements, clarification questions, meta discussion about the conversation",
    needsTools: false,
    max_steps: 1,
    changes: "no",
    expected: "text",
  },

  // --- Tool-backed: classifier picks concrete tools from live registry ---
  shell_command: {
    description: "Run a single shell command and report output",
    needsTools: true,
    // Was 5; bumped to 12 on 2026-04-21. The 5-step cap was too tight for
    // any shell work involving curl + JSON escape or HTTP-payload work —
    // observed during the readiness-test mirror experiment where the agent
    // burned every iteration on quoting attempts before giving up.
    max_steps: 12,
    changes: "maybe",
    expected: "tool_and_summary",
    tool_pattern: /^(run_command|run_background_command|peek_process|list_processes|kill_process|read_file)$/,
  },

  shell_multi: {
    description: "Run several shell commands to accomplish a goal (install, diagnose, pipe-chain)",
    needsTools: true,
    // Was 8; bumped to 16 on 2026-04-21 for consistency with shell_command.
    // Multi-shell pipelines on Windows (bash-on-windows escape quirks)
    // often need several extra diagnostic steps.
    max_steps: 16,
    changes: "maybe",
    expected: "tool_and_summary",
    tool_pattern: /^(run_command|run_background_command|peek_process|list_processes|kill_process|read_file|write_file|edit_file)$/,
  },

  file_read: {
    description: "Read the contents of a file or list a directory",
    needsTools: true,
    max_steps: 3,
    changes: "no",
    expected: "tool_and_summary",
  },

  file_write: {
    description: "Create or overwrite a file with specific content. ALWAYS pick this when the user asks to SAVE/WRITE/STORE generated text to a file or path (e.g. 'write a tweet and save to /tmp/x.txt', 'generate an outline and save it to ...'). The text-generation part does NOT make it creative_text once a file destination is named.",
    needsTools: true,
    max_steps: 3,
    changes: "yes",
    expected: "tool_and_summary",
  },

  file_edit: {
    description: "Modify an existing file: read it, change parts, write it back",
    needsTools: true,
    max_steps: 5,
    changes: "yes",
    expected: "tool_and_summary",
  },

  file_manage: {
    description: "Copy, move, delete, search across files",
    needsTools: true,
    max_steps: 6,
    changes: "yes",
    expected: "tool_and_summary",
  },

  web_fetch: {
    description: "Fetch a specific URL and report/parse its content",
    needsTools: true,
    max_steps: 3,
    changes: "no",
    expected: "tool_and_summary",
    // Widen: when user asks to read a page, include browser tools too —
    // search-only gets stuck on JS-heavy sites (observed: linkedin/twitter/github).
    tool_pattern: /^(web_fetch|web_search|mcp_browser_)/,
  },

  web_search: {
    description: "Search the web for information on a topic, including 'open <site>', 'navigate to', 'search on <site>' — these are tool-backed browsing, not just a search engine query",
    needsTools: true,
    max_steps: 8,
    changes: "no",
    expected: "tool_and_summary",
    // Same widening, so "go to LinkedIn" no longer gets only web_search.
    tool_pattern: /^(web_search|web_fetch|mcp_browser_)/,
  },

  task_create: {
    description: "Create a new plan with tasks, or add a task to an existing plan",
    needsTools: true,
    max_steps: 3,
    changes: "maybe",
    expected: "tool_and_summary",
  },

  task_update: {
    description: "Change the status of a task (done, skipped, in_progress), add notes, mark progress",
    needsTools: true,
    max_steps: 3,
    changes: "maybe",
    expected: "tool_and_summary",
  },

  task_view: {
    description: "Show the current plan, list tasks, check progress",
    needsTools: true,
    max_steps: 2,
    changes: "no",
    expected: "tool_and_summary",
  },

  memory_write: {
    description: "Remember something for later: save a fact, note, or preference",
    needsTools: true,
    max_steps: 3,
    changes: "maybe",
    expected: "tool_and_summary",
  },

  memory_read: {
    description: "Recall something from memory: search past notes, find saved facts",
    needsTools: true,
    max_steps: 4,
    changes: "no",
    expected: "tool_and_summary",
  },

  memory_manage: {
    description: "Write AND read memory in the same task: save then verify, delete then confirm, or similar multi-step memory flows",
    needsTools: true,
    max_steps: 12,
    changes: "maybe",
    expected: "tool_and_summary",
  },

  agent_spawn: {
    description: "Delegate work to a child agent, ask another agent, or wait for agents to finish",
    needsTools: true,
    max_steps: 5,
    changes: "maybe",
    expected: "tool_and_summary",
  },

  desktop: {
    description: "Interact with a remote desktop: screenshot, click, type, open apps, browse, run desktop shell",
    needsTools: true,
    max_steps: 20,
    changes: "maybe",
    expected: "tool_and_summary",
    // Desktop + browser both can handle screenshots/clicks; expose both families.
    tool_pattern: /^(mcp_screenbox_|mcp_browser_|view_image)/,
  },

  system_info: {
    description: "Report info about Flint itself: balance, models, providers, active plan, think out loud",
    needsTools: true,
    max_steps: 2,
    changes: "no",
    expected: "tool_and_summary",
  },

  complex_multi: {
    description: "Multi-step task combining several categories (web + file + shell, plan + execute, etc.) — requires full tool surface",
    needsTools: true,
    max_steps: 30,
    changes: "maybe",
    expected: "mixed",
  },
};

// Compact list for classifier prompt — just name + description
export function formatIntentCatalog() {
  return Object.entries(INTENTS)
    .map(([name, spec]) => `  ${name}: ${spec.description}`)
    .join("\n");
}

// Resolve intent name → full spec with defaults
export function resolveIntent(name) {
  return INTENTS[name] || INTENTS.complex_multi;
}
