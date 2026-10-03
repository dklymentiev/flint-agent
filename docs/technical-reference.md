# Flint Agent -- Technical Reference

**Version:** 1.14.0
**Checked against the code:** 2026-10-02
**Source:** The main exported functions, tools, endpoints, commands and config options in `src/`

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Configuration (`src/config.js`, `src/profiles.js`)](#configuration)
3. [CLI (`src/cli.js`, `src/launcher.js`)](#cli)
4. [Bootstrap (`src/bootstrap.js`)](#bootstrap)
5. [Entry Point (`src/index.js`)](#entry-point)
6. [Agent Loop (`src/agent/`)](#agent-loop)
7. [Tools (`src/tools/`)](#tools)
8. [API (`src/api/`)](#api)
9. [Message Bus (`src/bus/`)](#message-bus)
10. [Memory (`src/memory/`)](#memory)
11. [Tasks (`src/tasks/`)](#tasks)
12. [Security (`src/security/`)](#security)
13. [MCP Client (`src/mcp-client.js`)](#mcp-client)
14. [Providers (`src/providers/`)](#providers)
15. [Plugins (`src/plugins/`)](#plugins)
16. [Store (`src/store/`)](#store)
17. [Commands (`src/commands/`)](#commands)
18. [Components (`src/components/`)](#components)
19. [Sessions (`src/sessions.js`)](#sessions)
20. [Logging (`src/logging/`)](#logging)
21. [UI (`src/ui/`)](#ui)
22. [Other Modules](#other-modules)

---

## Architecture Overview

Flint is a terminal AI agent built with React/Ink for the TUI, Zustand for state management, and a SQLite-backed message bus for all input channels. The architecture follows a layered design:

```
User/API Input
     |
  Message Bus (SQLite priority queue)
     |
  Drain Loop (sequential consumer)
     |
  Intent Classifier (optional cheap LLM call, picks the tools)
     |
  Agent Loop (main LLM + tool execution)
     |  |-- Supervisor (pattern-matching hints)
     |  |-- Flow Controller (loop detection, auto-continue)
     |  |-- Compression and context swap (context management)
     |  '-- Security Hooks (path, command, network, child depth, content)
     |
  Tool Registry (filesystem, process, agent, memory, tasks, swap, MCP, plugins...)
```

Key subsystems:
- **Bus**: All inputs (console, HTTP API, child agents, reminders) push to a SQLite priority queue; a single drain loop processes messages sequentially. Stdio mode (`src/stdio/`) runs one session over stdin/stdout instead of the console.
- **Intent Layer**: When `INTENT_MODEL` is set, a cheap classifier model runs before the main agent loop to pick the intent class and filter the tool surface. Without it, every turn gets the built-in tools and MCP tools as described under `src/agent/intent.js`.
- **Supervisor**: Zero-cost local pattern matching that injects hints after tool calls (e.g., "click without look", repeated actions). Off in the console until `/supervisor`; on for API messages.
- **Flow Controller**: Unified loop detection (text, tool, desktop) and auto-continue decisions.
- **Security**: `src/security/` holds the orchestrator (`index.js`), policies, safety constants, path guard, command guard, network guard, content fence, content validator, persona guard, watchdog, audit, pairing, API auth and child policy.
- **Memory**: HMAC-protected JSONL for `memory_*` entries, per-session facts and conversation digests, and a SQLite store (`~/.flint/memory/`) for five memory layers: reflections, patterns, skills, facts and a user model.
- **Tasks**: SQLite-backed goals/tasks with subtasks, scheduling, daily focus, multi-goal support.
- **Spend modes** (`src/spend.js`): economy, normal and generous set together how many MCP tools are offered whole and when compression and swap start.

---

## Configuration

### `src/config.js`

Central configuration object. Reads from CLI args, env vars, persisted provider state, and defaults.

#### Exported: `config` (object)

| Property | Type | Default | Env Var | Description |
|---|---|---|---|---|
| `provider` | string | `"openrouter"` | `FLINT_PROVIDER` | Active LLM provider ID |
| `model` | string | provider default | `OPENROUTER_MODEL` | Active model ID |
| `apiKey` | string (getter) | env fallback | `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` | API key for current provider (lazy resolution). Other providers take their key from the encrypted store (`/key`) only |
| `apiUrl` | string (getter) | derived | -- | Full API endpoint URL for chat completions |
| `port` | number | `3000` | `--port`; `AGENT_PORT` only in a child agent | HTTP API server port |
| `portExplicit` | boolean | `false` | `--port` | A port named with `--port` is bound or the start fails; otherwise the server tries the next ports |
| `memoryUrl` | string\|null | `null` | `MEMORY_API_URL` | Mesh memory API base URL |
| `maxResponseTokens` | number | `16384` | `AGENT_MAX_RESPONSE_TOKENS` | Max tokens per LLM response |
| `maxDisplayLines` | number | `1000` | `AGENT_MAX_LINES` | Max lines in TUI output buffer |
| `maxResponseLines` | number | `500` | `AGENT_MAX_RESPONSE_LINES` | Max lines in agent response display |
| `mcpServers` | string\|null | `null` | `MCP_SERVERS` | Comma-separated MCP server configs |
| `maxIterations` | number | `150` | `AGENT_MAX_ITERATIONS` | Max agent loop iterations per message |
| `maxCostPerAction` | number | `0` | `AGENT_MAX_COST` | Per-action cost budget in $ (0=unlimited) |
| `sessionBudget` | number | `0` | `AGENT_SESSION_BUDGET` | Session-level $ limit (0=unlimited) |
| `compressAfterTokens` | number\|null | `null` | `COMPRESS_AFTER_TOKENS` | Token threshold for context compression. Unset: derived from the model's window and the spend mode (see `src/agent/compression.js`) |
| `headless` | boolean | `false` | -- | Set by `--headless` and stdio mode (no console) |
| `fallbackAllTools` | boolean | `false` | `FLINT_FALLBACK_ALL_TOOLS=1` | With the classifier off, offer every live tool instead of the inline limit plus `tool_search` |
| `apiAutoApprove` | boolean | `true` | `AGENT_API_AUTO_APPROVE` | Auto-approve tools for authenticated API callers (`0` turns it off) |
| `pluginInstall` | string | `"ask"` | `FLINT_PLUGIN_INSTALL` | `allow` lets `install_plugin` / `reload_plugins` run without asking; anything else asks |
| `openrouterProvider` | object\|null | `null` | `OPENROUTER_PROVIDER_ONLY`, `_IGNORE`, `_ORDER`, `_SORT` | OpenRouter host preference for the main model |
| `selfVerify` | string | `"off"` | `FLINT_SELF_VERIFY=on` | After "done" on a turn that changed files and ran nothing, one more round asks the model to show the change works |
| `autoMaxIterations` | number | `50` | `AGENT_AUTO_MAX_ITERATIONS` | Max iterations in autonomous mode |
| `autoMaxCost` | number | `0.50` | `AGENT_AUTO_MAX_COST` | Max cost in autonomous mode |
| `sessionsDir` | string | `<root>/sessions` | `FLINT_DATA_DIR` | Directory for session files: `<FLINT_DATA_DIR>/sessions` when set, `<root>/sessions/children` in a child agent |
| `projectRoot` | string | resolved | -- | Flint project root directory |
| `permissionsFile` | string | `<root>/.permissions.json` | -- | Saved permission overrides, the care level and per-file approvals |
| `workdirBase` | string | `""` | `AGENT_WORKDIR` | Working directory for file tools |
| `allowedPaths` | string[] | `[]` | `AGENT_ALLOWED_PATHS` | Filesystem sandbox (comma-separated) |
| `maxChildAgents` | number | `5` | `AGENT_MAX_CHILDREN` | Max concurrent child agents |
| `childIdleTimeout` | number | `60` | `AGENT_CHILD_IDLE_TIMEOUT` | Seconds before idle child exits |
| `childCleanupDelay` | number | `30000` | `AGENT_CHILD_CLEANUP_DELAY` | Ms before removing stopped agent from registry |
| `shell` | string | auto-detect | `AGENT_SHELL` | Shell for run_command (Git Bash on Windows) |
| `maxBatchFiles` | number | `20` | `AGENT_MAX_BATCH_FILES` | Max files per write_file batch |
| `securityPolicy` | string | `"normal"` | `AGENT_SECURITY_POLICY` | Security profile: strict/normal/permissive |
| `extractionModel` | string | `"google/gemini-2.0-flash-001"` | `EXTRACTION_MODEL` | Cheap model for fact extraction |
| `compressThreshold` | number | `500` | `COMPRESS_THRESHOLD` | Char threshold for head/tail compression |
| `maxContextChars` | number | `20000` | `MAX_CONTEXT_CHARS` | Max chars for FLINT.md context injection |
| `maxPromptTokens` | number | `100000` | `MAX_PROMPT_TOKENS` | Budget for the system prompt sections (`src/agent/prompt-budget.js`) |
| `intentModel` | string\|null | `null` | `INTENT_MODEL` | Model for intent classification. Unset turns the classifier off |

#### `config.resolveApiKey()` -> `Promise<string|null>`

Asynchronously resolves the API key from encrypted storage, falling back to environment variables. Call at startup.

#### Exported: `needsFirstRunSetup` (boolean)

`true` if no API keys are configured anywhere (encrypted storage or env vars).

### `src/profiles.js`

Profile system for role-specific system prompts.

#### `loadProfilesConfig()` -> `object`

Reads `profiles/profiles.json`. Returns the full profiles config map or `{}` on error.

#### `loadProfile(name)` -> `{ content: string, contextMode: string, windowSize: number, description: string }`

Loads a profile by name. Reads the prompt file specified in profiles.json. Throws if profile not found.

#### `listProfiles()` -> `string[]`

Returns all available profile names.

#### `getProfileDescription(name)` -> `string`

Returns description for a profile, or `""` if not found.

---

## CLI

### `src/cli.js`

CLI argument parsing and first-run setup.

#### `getArgValue(name)` -> `string|null`

Extracts the value following a CLI flag (e.g., `--model gpt-4` -> `"gpt-4"`).

#### `parseCLI()` -> `{ action: string, ... }`

Parses process.argv. Returns:
- `{ action: "list" }` -- `--list`
- `{ action: "headless", task, cwd, budget }` -- `--headless`
- `{ action: "new" }` -- `--new` (default)
- `{ action: "last" }` -- `--last`
- `{ action: "resume", id }` -- `--session <id>`

Stdio mode is decided before `parseCLI()`: `src/stdio/guard.js` reads `--stdio`, or `--input-format stream-json` / `--output-format stream-json`, with `parseStdioArgs()` from `src/stdio/args.js`, and `src/index.js` then runs with `{ action: "stdio", ... }`. `bin/flint.js` runs that mode in its own process, without the launcher. `--version` (or `-v`) prints the version and exits in `bin/flint.js`, `src/launcher.js` and `src/index.js`.

#### `runListSessions()` -> `Promise<void>`

Lists all saved sessions to stdout and exits.

#### `migrateKeys()` -> `Promise<void>`

Migrates API keys from env vars (`OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`) into encrypted storage if not already present.

#### `runFirstRunSetup(cli)` -> `Promise<void>`

Interactive first-run wizard. Prompts user to choose a provider and enter an API key. Skipped if keys exist or `cli.action === "list"`.

### `src/launcher.js`

Wrapper that spawns `src/index.js` as a child process. Shows a loading splash. Handles restart: exit code 42 (`RESTART_CODE` in `src/restart.js`) starts Flint again with `--session <id>` of the session it was running, so `/restart`, `POST /restart` and `restart_agent` continue the same session.

---

## Bootstrap

### `src/bootstrap.js`

Orchestrates all startup phases in order.

#### `buildSystemMessage(profileName, sessionId)` -> `{ role: "system", content: string }`

Builds the full system message by loading a profile and calling `getSystemMessage()`.

#### `bootstrap(cli, pkg)` -> `Promise<{ log, initialMessages, initialInputHistory, explicitProfile }>`

Runs startup phases in sequence:
1. `initProfile()` -- resolve active profile (`--profile` > `AGENT_PROFILE` > default "generic")
2. `initOnboarding()` -- ask the care-level question once (safe / normal / permissive) if it has never been answered
3. `initStore()` -- init output, registry, commands, permissions, security
4. `initTools()` -- register task, inbox, dataset tools
5. `initMesh()` -- register Mesh tools (if `MEMORY_API_URL` is set)
6. `initMcp()` -- connect to MCP servers (background, non-blocking)
7. `initPlugins()` -- load plugins from `~/.flint/plugins/`
8. `initSystemMessage()` -- prefetch agent-memory, build system prompt
9. `initSession()` -- create/resume session, restore state
10. `initWorkspace()` -- create workspace directory, init logger
11. `syncPlan()` -- sync SQLite tasks to store
12. `fetchModelInfo()` -- get pricing for current model (background)

---

## Entry Point

### `src/index.js`

Main application. Key responsibilities:
- Imports `src/production-env.js` first, so React and Ink load their production builds
- Force exit on three SIGINTs within 2 s (the console itself exits on two Ctrl+C presses within 2 s)
- 30 s startup watchdog (`src/startup-watchdog.js`); time spent waiting for the operator does not count
- Console.log override (routes to store)
- Ink console render (`src/components/App.js`)
- Graceful shutdown (save session, kill children, close DB)
- Session replay on resume (`src/ui/replay.js`: the last 80 lines)
- Clipboard reading for `/paste` and Alt+V (Windows PowerShell)
- Main `handleInput()` function processing user input through the bus
- Bus integration: all messages go through `bus.push()`, then the drain loop
- Reminder scheduler (every 30 s checks due tasks, pushes to inbox)
- Agent registry for multi-instance coordination
- Stdio mode: reads the host's prompt files and `.mcp.json` before bootstrap, then hands over to `runStdio()` (`src/stdio/run.js`)

---

## Agent Loop

### `src/agent/agent.js`

The core agent loop -- callback-based, no React/store dependency.

#### `runAgent(messages, callbacks, options)` -> `Promise<{ text: string, stats: object, stop_reason: string }>`

**Parameters:**
- `messages` (Array) -- conversation messages array (mutated in place)
- `callbacks` (object):
  - `onThinking()` -- spinner start
  - `onToken(token)` -- streaming token
  - `onStreamEnd()` -- streaming done
  - `onToolStart(name, args)` -- tool execution starting
  - `onToolResult(name, result)` -- tool finished
  - `onThought(text)` -- think tool used
  - `onApiCall(callNum, messages, tools)` -- before API call
  - `onApiResponse(callNum, reply, usage)` -- after API call
  - `onCheckQueue()` -- returns pending user messages for real-time feedback
  - `getCurrentPlanStep()` -- returns current plan step reminder
  - `onActivity(...)` / `onFirstToken()` / `onTick(...)` / `onStepAbort(...)` / `onScopeNote(...)` -- feed the console's activity line, waits and notices
- `options` (object):
  - `sessionId` (string)
  - `signal` (AbortSignal)
  - `sessionSummary` (string)

**Returns:** `{ text, stats: { promptTokens, completionTokens, contextTokens, generationIds, _cost }, stop_reason }` where `stop_reason` is one of `"done"`, `"budget"` (iteration limit or a cost ceiling), `"stall"` (no first token after repeated attempts), `"empty"` (the model answered with nothing three times), `"text-tool-call"` (the model wrote its tool calls as text), `"denied"`, `"error"`, or a provider failure kind (`"auth"`, `"quota"`, `"rate-limit"`)

**Behavior:**
1. Conversation swap first (`src/agent/swap.js`): in a long talk the oldest whole turns become one swap entry with a short model-written summary
2. Runs intent classification via `classifyIntent()`
3. Filters tools by intent manifest
4. Injects intent hint into system message
5. Loops: API call, handle response, execute tools, repeat
6. Iteration limit (`AGENT_MAX_ITERATIONS`, then one summary turn); the cost and session ceilings are enforced at the door
   (`chatCompletion`), and this loop ends the turn when the door refuses
7. Context compression and context swap between iterations
8. Safety re-prompts every 8 API calls
9. Supervisor evaluation after each tool call
10. Loop detection (text, tool, desktop)
11. Self-verification gate, off unless `FLINT_SELF_VERIFY=on` (claims success on a turn that changed files and ran nothing, one verify iteration)
12. Persona hijack detection on final output
13. Mid-task description nudge (model describes instead of acting)
14. Retries with growing pauses on temporary provider errors and empty answers (`src/agent/backoff.js`), and a first-token watchdog (`src/agent/watchdog.js`)

### `src/agent/usage.js`

The accounting. What a call cost, what has been spent, and whether the next one
is allowed. Every provider call goes through `src/api/client.js`, which asks
this module both questions; nothing else records or checks.

#### `recordUsage(source, usage, pricing?)` -> `entry|null`

Books one call against `source` (one of `USAGE_SOURCES`). Takes the provider's
reported `usage.cost` when there is one and estimates only when there is not,
flagging the estimate.

#### `overBudget({perAction, session})` / `assertWithinBudget(...)`

Which ceiling is spent, or nothing. `assertWithinBudget` throws
`BudgetExceededError` instead of reporting. A ceiling of `0` is unlimited.

#### `beginAction()` / `beginRun(limit)` / `endRun()` / `getSpend()`

The three windows onto the same stream of calls: one turn, the session, one
autonomous run. `getSpend()` returns `{action, session, run}` in dollars.

#### `drainUsage()` -> `{source: entry}`

Everything booked since the last drain, for display. Does not touch the totals.

### `src/agent/auto.js`

Autonomous mode -- plan-driven loop.

#### `runAutoMode(task, options)` -> `Promise<{ completed, iterations, totalCost, tasksTotal, tasksDone, tasksSkipped }>`

**Parameters:**
- `task` (string) -- user's task description (null to resume)
- `options`:
  - `processMessage` (Function)
  - `getStore` (Function)
  - `printSystem` / `printWarning` (Functions)
  - `maxIterations` (number, default 50)
  - `maxCost` (number, default 0.50)
  - `isAborted` (Function)
  - `resume` (boolean)

Sandboxes the agent (blocks access to Flint's own source), forces plan creation, iterates through tasks with budget warnings at 70% and 90%.

### `src/agent/intent.js`

Intent classifier -- one cheap LLM call before the main agent loop.

#### `classifyIntent(ctx)` -> `Promise<object>`

**Parameters:**
- `ctx.newMessage` (string) -- new user message
- `ctx.availableTools` (Array) -- live tool defs from registry
- `ctx.sessionSummary` (string, optional) -- session summary
- `ctx.recentMessages` (Array, optional) -- last few messages

**Returns:** `{ intent, tools: string[], max_steps, expected, user_wants, reason, fallback }`

No classifier call is made, and a fallback manifest (`complex_multi`) is returned, when:
- `INTENT_MODEL` is not set (the classifier is off)
- `FLINT_NO_CLASSIFIER=1`
- headless mode (`--headless`, stdio mode)
- `FLINT_TOOL_MODE=search`: a core tool set, the tools `tool_search` has loaded this session, and `tool_search` itself

The fallback offers all built-in tools. MCP tools are offered whole up to `mcpInlineMax()` (set by the spend mode: 10, 30 or 200, see `src/spend.js`; `FLINT_MCP_INLINE_MAX` overrides); past that, only the ones `tool_search` has already loaded, and the model finds the rest through `tool_search`. `FLINT_FALLBACK_ALL_TOOLS=1` offers every tool.

Features when the classifier runs:
- LRU cache (50 entries, 5min TTL) keyed by SHA-256 of inputs
- Prompt injection guard (detects classifier-control keywords, returns full-tool fallback)
- Shadow log to `~/.flint/intent-decisions.jsonl`
- Retry on 5xx errors (3 attempts); per-attempt timeout from `INTENT_TIMEOUT_MS` (default 15 s, `src/agent/intent-timeout.js`)
- Falls back to `complex_multi` on any error

#### `filterToolsByManifest(allTools, manifest)` -> `Array`

Filters tool definitions to only those named in the manifest. Returns empty array for text-only intents.

#### `formatIntentHint(manifest)` -> `string`

Builds a `<intent>` block for injection into the system message. Returns `""` for fallback manifests.

### `src/agent/intent-manifest.js`

Intent catalog -- defines all intent classes.

#### Exported: `INTENTS` (object)

22 intent classes:

| Intent | needsTools | max_steps | Description |
|---|---|---|---|
| `creative_text` | false | 1 | Generate text (poems, stories, code snippets) |
| `knowledge_qa` | false | 1 | Factual questions |
| `reasoning` | false | 2 | Math, logic, puzzles |
| `chat` | false | 1 | Small talk, greetings |
| `shell_command` | true | 12 | Single shell command |
| `shell_multi` | true | 16 | Multiple shell commands |
| `file_read` | true | 3 | Read file / list directory |
| `file_write` | true | 3 | Create/overwrite file |
| `file_edit` | true | 5 | Modify existing file |
| `file_manage` | true | 6 | Copy, move, delete, search |
| `web_fetch` | true | 3 | Fetch specific URL |
| `web_search` | true | 8 | Search the web |
| `task_create` | true | 3 | Create plan/tasks |
| `task_update` | true | 3 | Update task status |
| `task_view` | true | 2 | View plan/progress |
| `memory_write` | true | 3 | Save facts/notes |
| `memory_read` | true | 4 | Recall from memory |
| `memory_manage` | true | 12 | Combined memory R/W |
| `agent_spawn` | true | 5 | Delegate to child agent |
| `desktop` | true | 20 | Remote desktop interaction (through MCP tools) |
| `system_info` | true | 2 | Agent system info |
| `complex_multi` | true | 30 | Multi-category tasks |

#### `formatIntentCatalog()` -> `string`

Returns compact name+description list for classifier prompt.

#### `resolveIntent(name)` -> `object`

Looks up intent spec by name, falls back to `complex_multi`.

### `src/agent/supervisor.js`

Real-time supervisor -- zero-cost local pattern matching.

#### `setSupervisorEnabled(enabled)` -> `void`

Toggle supervisor on/off (`/supervisor`, `/supervisor off`). Off by default; auto-enabled for API messages.

#### `isSupervisorEnabled()` -> `boolean`

#### `setSupervisorKnowledgeFn(fn)` -> `void`

Inject a knowledge search function for auto-lookup when agent is stuck.

#### `evaluateToolCall(toolName, args, result, context)` -> `string|null`

Called after each tool execution. Returns a hint string to inject as system message, or null.

**Rules:**
- Click without prior `desktop_look`
- Same coordinates clicked 3x
- Local tool used when remote desktop is active
- GUI app launched without window activation
- apt-get/sudo on Screenbox (no root)
- LibreOffice without DISPLAY
- Headless conversion while GUI is running
- Save As workflow guidance
- Recovery/Discard dialog detection
- Tip of the Day dialog
- Text Import dialog
- Unverified write action
- Same tool called 3x in a row with the same arguments

Most rules are about remote desktop tools, which come from MCP servers.

**Escalation (4 levels):** hint -> warning -> re-plan -> hard stop (SUPERVISOR OVERRIDE).

#### `checkMidTaskDescription(text, hadToolCalls)` -> `string|null`

Detects when agent describes next steps instead of acting. Returns nudge hint.

#### `evaluateReflection(opts)` -> `string|null`

Conditional reflection trigger. Fires on: large results (>3k chars), errors, every 5 calls, or repeated actions. Includes EXPECT evaluation.

#### `trackExpect(assistantText)` -> `void`

Extracts `EXPECT: ...` from assistant text for next reflection evaluation.

#### `resetSupervisor()` -> `void`

Resets all supervisor state (tool history, hint counts, reflection counter).

### `src/agent/flow-controller.js`

Unified flow state machine -- loop detection and auto-continue.

#### `checkTextLoop(text)` -> `{ type, count, action, message }|null`

Detects repeated short text responses. Threshold: 5 repeats (configurable via `AGENT_LOOP_TEXT_REPEAT`).

#### `checkToolLoop(toolName, args)` -> `{ type, count, action, message }|null`

Detects repeated tool calls with fuzzy signature matching (coordinates rounded to grid, text truncated). Thresholds: 5 for regular tools, 7 for screenshots, 8 for commands (`AGENT_LOOP_TOOL_REPEAT`, `AGENT_LOOP_TOOL_SCREENSHOT`, `AGENT_LOOP_TOOL_COMMAND`).

#### `checkDesktopLoop(toolCalls)` -> `{ type, count, action, message }|null`

Detects observation-only loops (screenshot+look without any action). Threshold: 8 consecutive observations (`AGENT_LOOP_DESKTOP_OBS`).

#### `resetDesktopOnMeaningfulText(text)` -> `void`

Resets desktop observation counter when agent outputs completion keywords.

#### `shouldContinue(opts)` -> `{ action: "stop"|"continue"|"verify", message?, prompt?, goalComplete? }|null`

Decides whether to auto-continue after agent returns. Logic:
- The operator typed something during auto-continue = stop (pause the plan)
- No plan = stop
- Plan all done = check for more work or stop
- Plan has pending = continue with next task (up to 3 retries per task)
- API scope: goal done = stop

#### `isLearningOpportunity(opts)` -> `boolean`

Returns true if the completed task is worth learning from (multi-step plan or >5 tool calls).

#### `resetFlow()` -> `void`

Resets all flow state.

### `src/agent/system-prompt.js`

System prompt builder.

#### `prefetchAgentMemory()` -> `Promise<string|null>`

Tries to call `agent-memory context --budget 3000` binary for pinned context. Caches result.

#### `getSystemMessage(sessionId, opts)` -> `{ role: "system", content: string }`

Builds the complete system message. Sections are budgeted by `createBudgetAllocator()` (`src/agent/prompt-budget.js`); the stable sections come first so the provider's prompt cache covers them. Components:
1. Core prompt from Flint's own `system.md` (or a one-line fallback), plus a token-saving section in economy spend mode
2. Project rules from `FLINT.md`, found by walking up from the CWD (with injection scan, `src/agent/project-context.js`)
3. Profile prompt (role-specific); in stdio mode the host's prompt (CLAUDE.md files, `--system-prompt`, `--append-system-prompt`) is added here
4. Environment info (OS, architecture, shell, CWD). No date or time: each operator message carries `[Local time: ...]` instead (`src/agent/time-stamp.js`)
5. Child agent mode instructions (if `AGENT_TASK_ID` set)
6. Flint capabilities from the bundled README
7. MEMORY.md head (persistent memories)
8. Agent-memory pinned context
9. Memory layers: reflections, patterns, skills index, facts, user model
10. Per-turn mode rules for the intent class (`src/agent/modes.js`)
11. Session facts
12. Conversation digest
13. Dataset registry
14. Inbox notification hint

### `src/agent/knowledge.js`

Backend-agnostic knowledge store for learned facts and patterns.

#### `store(entry)` -> `void`

Stores a fact/pattern to `knowledge/facts.jsonl` beside the sessions folder. Entry: `{ type, text, context, confidence, triggers }`.

#### `retrieve(query, limit)` -> `Array`

Keyword-based search across stored facts. Returns entries sorted by relevance (word matches * confidence).

#### `updateConfidence(index, delta)` -> `void`

Adjusts confidence of a fact (+0.1 on success, -0.1 on failure). Clamped to [0, 1].

#### `getAll()` -> `Array`

Returns all stored facts.

#### `formatForPrompt(entries)` -> `string|null`

Formats retrieved knowledge for prompt injection.

### `src/agent/learning.js`

Extracts facts and patterns from completed tasks (no LLM calls).

#### `extractLearnings(opts)` -> `void`

**Parameters:** `{ messages, task, plan, outcome }`

Extracts:
- **Patterns**: ordered sequence of unique tool names (e.g., "search -> read -> save -> open")
- **Facts**: contextual tool usage observations (e.g., "use desktop_shell for remote file creation")

Skips if outcome is "failed" or pattern already known.

### `src/agent/compression.js`

Context compression with configurable threshold.

#### `compressThreshold()` / `compressThresholdFor(window, level)`

The token count at which compression starts. `COMPRESS_AFTER_TOKENS` when set; otherwise a share of the model's context window set by the spend mode: economy 25% (at most 64k, 32k when the window is unknown), normal 50% (at most 128k, 64k unknown), generous 80% (no cap, 200k unknown).

#### `summarizeToolResult(content, toolName, toolArgs)` -> `string`

Generates a one-line summary for tool results (type-aware). E.g., `[Read /path (100 lines, 5000 chars): first line...]`.

#### `compressContext(messages, prevIterationStart, iterationStart, sessionId, opts)` -> `Promise<number>`

Threshold-based compression pipeline:
1. **Action logging** (always): tracks side-effect tools as session facts
2. **Image replacement**: replaces previous base64 images with text descriptions
3. **Fact extraction** (sync): extracts facts from old messages before compression
4. **Head/tail truncation** (age=1): keeps first 8 + last 3 lines
5. **One-line summary** (age>=2): type-aware summarization

Returns tokens saved.

### `src/agent/content-resolver.js`

Determines actual content type of MCP response data.

#### `resolveContent(blocks)` -> `{ type, mimeType?, data?, text?, parts? }`

Resolves MCP content blocks by inspecting mimeType, data content, and magic bytes. Returns normalized typed result:
- Single text -> merged text
- Single image -> `{ type: "image", mimeType, data, text }`
- Image + text -> media with text metadata
- Mixed -> `{ type: "mixed", parts: [...] }`

### `src/agent/swap.js`

Context swap (docs/context-swap.md). Once the context passes a threshold set by the spend mode, big old tool results move to the session's `swap/` folder with an index and leave a one-line stub; `swap_list` and `swap_read` bring them back. Conversation swap moves the oldest whole turns of a long talk into one entry with a short summary. `FLINT_SWAP=0` turns both off. Main exports: `swapEnabled()`, `swapSettings()`, `createSwapStore(dir)`, `applySwap()`, `applyConversationSwap()`.

### Other agent modules

| Module | What it does |
|---|---|
| `modes.js` | Maps intent classes to behavior modes: rules added to the prompt per turn, iteration budget |
| `steering.js` | Nudges that apply to the next model call only, instead of staying in the conversation |
| `watchdog.js` | First-token timeout for a model call, and the stall notices |
| `backoff.js` | Growing pauses for empty answers and temporary provider errors |
| `prompt-budget.js` | Allocates the system prompt budget across sections by priority, min and max |
| `toolcall-text.js` | Detects tool calls the model wrote as text instead of calling them |
| `tool-guard.js` | Decides whether the classifier's tool pick is trusted for a turn |
| `vision.js` | Whether the model can see images; strips them and says so when it cannot |
| `workspace-changes.js` | What a turn changed, read from the folders it works in |
| `time-stamp.js` | The `[Local time: ...]` line on each operator message |
| `reflection-extractor.js` | End-of-session reflection (memory layer 1) |
| `outcome-ask.js` | Asks the model which of three outcomes happened on a turn that changed nothing |

---

## Tools

### `src/tools/registry.js`

Central tool registry managing definitions and handlers.

#### `initRegistry(store)` -> `void`

Initializes with filesystem, process, system, agent, memory and plugin tools, `tool_search`, and the two swap tools (unless `FLINT_SWAP=0`). Bootstrap then adds task, inbox and dataset tools, Mesh tools when `MEMORY_API_URL` is set, MCP tools and plugin tools.

First-party tools: 61 with Mesh configured, 58 without (11 filesystem, 5 process, 12 system, 4 agent, 8 memory, 2 plugin, 1 `tool_search`, 2 swap, 11 task, 1 inbox, 1 dataset, 3 Mesh). Desktop control is not built in; it comes from an MCP server.

#### `registerMcpTools(tools, handlers, status)` / `registerMeshTools` / `registerTaskTools` / `registerDatasetTools` / `registerScheduleTools` / `registerInboxTools` / `registerPlugin`

Registration functions for different tool categories. Each adds tool definitions to `allTools[]` and handlers to `handlerMap{}`.

#### `getDefinitions()` -> `Array`

Returns all registered tool definitions (OpenAI function calling format).

#### `executeTool(name, args)` -> `Promise<string>`

Validates args against tool schema, then executes the handler. Returns result string or error message.

### `src/tools/tool-search.js`

`tool_search` (`query, limit?`): finds tools by describing the job. Its description lists every MCP server; a found tool stays loaded for the rest of the session. Used with the classifier off once MCP tools pass the inline limit, and for everything outside a core set under `FLINT_TOOL_MODE=search`.

### `src/tools/swap-tools.js`

| Tool | Parameters | Description |
|---|---|---|
| `swap_list` | `turn?, since?, source?, text?, limit?` | List what this session moved out of the context |
| `swap_read` | `id, offset?, limit?` | Read a swapped entry back, whole or in lines |

### `src/tools/plugin-tools.js`

| Tool | Parameters | Description |
|---|---|---|
| `install_plugin` | `source` | Install a plugin and load it at once, usable in the same turn |
| `reload_plugins` | -- | Re-read the plugins folder and load every plugin fresh |

Both ask before running unless `FLINT_PLUGIN_INSTALL=allow`, and are refused in a run with no operator.

#### MCP Management

- `setMcpManagement(fns)` -- inject disconnect/reconnect/status functions
- `getMcpStatus()` / `getMcpServerStatus()` -- get MCP server status
- `mcpDisconnect(name)` / `mcpReconnect(name)` -- manage connections

### `src/tools/filesystem.js`

File system tools (11 tools).

#### Tools

| Tool | Parameters | Description |
|---|---|---|
| `read_file` | `path, offset?, limit?` | Read file. Auto-preview for large files (>1000 lines). Streaming for files >512KB. |
| `write_file` | `path?, content?, files?` | Write single or batch files. Creates directories automatically. |
| `list_directory` | `path` | List files/directories with type suffixes |
| `create_directory` | `path` | Create directory recursively |
| `copy_file` | `source, destination` | Copy file |
| `move_file` | `source, destination` | Move/rename file |
| `delete_file` | `path` | Delete file or empty directory |
| `search_in_files` | `pattern, path?, glob?, max_results?` | Regex search across files (skips node_modules, .git, etc.) |
| `view_image` | `path` | Load image as base64 for vision analysis |
| `edit_file` | `path, old_text, new_text, all?` | Find-and-replace in file |
| `glob` | `pattern, path?` | Find files matching glob pattern |

#### Path Resolution

- **Read paths**: resolved relative to `projectRoot` (in stdio mode, the agent's folder)
- **Write paths**: resolved relative to `config.workdir`: `AGENT_WORKDIR` when set, otherwise `sessions/<sessionId>/workspace/` (in stdio mode, the agent's folder)
- **Access control**: checked against `config.allowedPaths` and denied paths (`AGENT_DENIED_PATHS`, inherited by child agents)

#### `setDeniedPaths(paths)` / `getDeniedPaths()` / `clearDeniedPaths()`

Manages denied path list (used during auto mode to protect Flint's source).

#### `normalizeTmpPath(filePath)` -> `string`

On Windows, converts `/tmp/` to `os.tmpdir()` for cross-platform consistency.

### `src/tools/system.js`

System tools factory (web, model management, restart, MCP status, etc.).

#### `createSystemTools(store)` -> `{ tools, handlers }`

Returns combined process (5) + system (12) + agent (4) tools and handlers.

#### System Tools

| Tool | Parameters | Description |
|---|---|---|
| `web_fetch` | `url, method?, body?, headers?, max_length?` | HTTP fetch with HTML-to-Markdown conversion. 2MB body limit. |
| `web_search` | `query, num_results?` | Web search: DuckDuckGo first, then Bing, then Google (1 to 10 results, default 5) |
| `restart_agent` | `reason` | Schedule agent restart |
| `clear_context` | -- | Clear conversation history |
| `check_balance` | -- | Check OpenRouter API balance |
| `think` | `thought` | Internal reasoning (not shown to user) |
| `list_models` | `query?` | List available models with pricing. Curated filter for OpenRouter. |
| `switch_model` | `model_id, provider?` | Switch to different model |
| `switch_provider` | `provider_id` | Switch LLM provider |
| `list_providers` | -- | List available providers with key status |
| `list_mcp_servers` | -- | List configured MCP servers and their connection status |
| `reconnect_mcp` | `name` | Reconnect an MCP server by name (always asks) |

### `src/tools/process-tools.js`

Process management tools.

#### Tools

| Tool | Parameters | Description |
|---|---|---|
| `run_command` | `command, timeout_seconds?` | Execute shell command (timeout 120 s by default or `AGENT_COMMAND_TIMEOUT`, at most 600 s; 1 MB output limit). Runs with Flint's own Python venv and npm prefix first on PATH (`src/tools/own-env.js`, `FLINT_OWN_ENV=0` turns it off) |
| `run_background_command` | `command, label?` | Run in background (5min timeout, 5MB output limit, max 5 concurrent) |
| `kill_process` | `process_id` | Kill a background process |
| `list_processes` | -- | List all background processes |
| `peek_process` | `process_id, lines?` | Read last N lines of output |

#### `killAllChildren(timeoutMs)` -> `void`

Kills all active child processes and their process trees (SIGTERM then force SIGKILL after timeout). Windows: uses `taskkill /T /F`.

### `src/tools/agent-tools.js`

Multi-agent tools for spawning and communicating with child agents.

#### Tools

| Tool | Parameters | Description |
|---|---|---|
| `spawn_agent` | `task, task_id?, port?, profile?, model?, visible?` | Spawn child agent process |
| `ask_agent` | `port, message` | Send message to running child agent and wait for its answer |
| `list_agents` | -- | List all child agents with status |
| `wait_tasks` | `goal_id, timeout?` | Wait for all tasks in a goal to complete (polling) |

**spawn_agent details:**
- Auto-assigns port from 3010+
- Inherits denied paths + filtered API keys
- Supports visible mode (new console window via .bat on Windows, tmux/screen/terminal on Linux)
- Heartbeat monitoring (15s interval, 3 missed pings = "lost")
- Task-driven mode with `task_id` (child claims and updates SQLite task)
- Pairing secret for parent-child auth
- Own data folder per child (`<data dir>/children/<port>`), so no two processes share a queue
- Idle timeout (`AGENT_CHILD_IDLE_TIMEOUT`, default 60 s) that does not fire while a turn or queued work is running (`src/child-idle.js`)

### `src/tools/tasks.js`

Task planning tools backed by SQLite.

#### `createTaskTools(opts)` -> `{ tools, handlers }`

#### Tools

| Tool | Parameters | Description |
|---|---|---|
| `create_plan` | `goal, tasks[], project?` | Create persistent plan with tasks |
| `update_task` | `id, status, result?` | Update task status (done/in_progress/skipped) |
| `list_tasks` | -- | Show all plans, focused goal details, scheduled tasks |
| `add_task` | `title, description?, next_run?, repeat?, project?, scope?` | Add standalone/scheduled task |
| `add_task_note` | `task_id, note` | Add note to task |
| `link_task_file` | `task_id, path, role?` | Link file to task |
| `create_subtask` | `parent_id, subtasks[]` | Add subtasks (max 2 levels) |
| `focus_goal` | `goal_id` | Switch focus to different goal |
| `task_stats` | `project?` | Overview stats by project |
| `list_goals` | `status?` | List all goals |
| `today` | `task_ids?` | Show/set today's tasks |

#### `formatPlanForPrompt(plan)` -> `string`

Formats a plan with task status icons (+, >, o, -) for prompt injection.

### `src/tools/mesh.js`

Mesh semantic memory tools (requires `MEMORY_API_URL`).

#### Tools

| Tool | Parameters | Description |
|---|---|---|
| `mesh_search` | `query, limit?, tags?` | Semantic search across Mesh memory |
| `mesh_add` | `content, tags?` | Save document to Mesh memory |
| `mesh_recent` | `limit?, type?` | Get recent documents |

### `src/tools/dataset.js`

Dataset navigation tool for paginated table results.

#### `show_dataset` tool

Parameters: `id, page?`. Navigates to a specific page of a stored dataset.

### `src/tools/inbox-tools.js`

Inbox notification tools.

#### `check_inbox` tool

Parameters: `all?`. Returns unread notifications, marks as read. With `all=true`, shows all recent including read.

### `src/tools/checkpoint.js`

File checkpoint/rewind system.

#### `saveCheckpoint(filePath, type)` -> `Promise<void>`

Snapshots file content before modification. Called by write_file, edit_file, delete_file.

#### `rewind(count)` -> `Promise<Array<{ path, action }>>`

Undoes last N changes. Restores original content or deletes newly created files.

#### `rewindAll()` -> `Promise<Array>`

Undoes all changes in the stack.

#### `getCheckpointStack()` / `clearCheckpoints()` / `checkpointCount()`

Stack inspection and management.

### `src/tools/permissions.js`

Permission system with hooks, confirmation flow, and persistence.

#### Default Permission Levels

Base levels in `DEFAULT_PERMISSIONS`:

- **confirm**: `write_file`, `edit_file`, `delete_file`, `create_directory`, `copy_file`, `move_file`, `run_command`, `run_background_command`, `kill_process`, `spawn_agent`, `ask_agent`, `restart_agent`, `clear_context`, `install_plugin`, `reload_plugins`, `reconnect_mcp`
- **allow**: every other first-party tool. A test (`tests/unit/tools/permission-coverage.test.js`) fails if a first-party tool has no entry.
- A tool with no entry (a plugin or MCP tool) is `confirm`. The table also names some MCP tool names (desktop and mail tools).

The care level (`/careful`, asked once at first start, default `normal`) then decides what a `confirm` tool does, through `toolPermissionAtLevel()` in `src/security/policies.js`:

| Level | Tools that ask | Commands that ask (command guard) |
|---|---|---|
| `safe` | every `confirm` tool | every command |
| `normal` | `confirm` tools except file writes, copies, moves, directory creation, `run_command`, `run_background_command`, `kill_process` | destructive commands (recursive delete, force push, `git reset --hard`, `git clean -f`, `npm publish`, `docker rm`, `docker system prune`, `kubectl delete`) and one-way commands (push, publish, uploads, mail, file transfer) |
| `permissive` | only the ones that always ask | none |

`delete_file` and `reconnect_mcp` ask at every level. Reads never ask, except a read of a secret file (`.env`, private keys, credentials), which asks at every level. Hard blocks from the command guard stay at every level.

#### `initPermissions({ confirm, timeout })` -> `void`

Inject confirmation callback and timeout (default 10 minutes, then auto-deny).

#### `executeToolWithPermissions(name, args)` -> `Promise<{ result, denied }>`

Main wrapper. Pipeline:
1. Repair a misspelled tool name (edit distance up to 2, one clear match)
2. Run beforeHooks (first non-null verdict wins)
3. Check permission level (reads allowed unless the file looks secret)
4. For "confirm": call confirmFn with timeout. In a run with no operator attached (an API message), the call is refused instead of asked
5. Execute tool
6. Run afterHooks (can transform result)

Answers: `"yes"`, `"always"` (persists; for a command, remembered per project in `src/tools/command-approvals.js`; for a sensitive path, per file), `"no"`, `"timeout"` (auto-deny).

#### `bulkSetPermission(level)` -> `void`

Session-only global override. Used by YOLO mode and API auto-approve. Never persisted to disk.

---

## API

### `src/api/client.js`

Provider-agnostic API client.

#### `chatCompletion(messages, tools, onToken, opts)` -> `Promise<{ message, usage, generationId }>`

Sends messages to the active LLM provider. Every provider call goes through it, so it is where the cost ceilings are checked (`assertWithinBudget`) before anything is sent and where usage is recorded. Detects images and disables streaming for image requests. Uses provider-specific adapter (OpenAI or Anthropic format). In free mode it sends the saved fallback chain of free models (`src/free-models.js`).

#### `fetchModelInfo(modelId)` -> `Promise<{ prompt, completion, contextLength }|null>`

Fetches pricing and context length for a model.

### `src/api/server.js`

HTTP API server.

#### `startServer(port, store, processMessage, opts)` -> `Promise<{ server, port }>`

Starts an HTTP server on 127.0.0.1 with auto-port scanning (tries up to 20 ports). With a port named by `--port` it binds that port or fails.

#### API Endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/pair/request` | Initiate PIN-based pairing |
| `POST` | `/pair/confirm` | Verify PIN, receive bearer token |
| `POST` | `/message` | Send message to agent. Body: `{ content, name?, sync?, stream?, autonomous? }`. Default: async, answers 202 with a `messageId`. `?sync=true` waits for the result (180 s); `?stream=true` answers with Server-Sent Events (`src/api/stream-pipe.js`). A slash command in `content` runs at once and returns its output |
| `GET` | `/message/:id` | Poll for async message result (status, response, stats, `stop_reason`, tool calls) |
| `GET` | `/status` | Session info (model, message count, alive, session usage and cost) |
| `POST` | `/restart` | Save the session and restart, continuing it |
| `GET` | `/bus/log` | Recent bus events |
| `GET` | `/bus/stats` | Bus queue statistics |
| `POST` | `/dataset` | Push dataset from child agent |
| `GET` | `/datasets` | List active datasets |
| `GET` | `/history` | Conversation history (supports `?limit=N&offset=M`) |
| `GET` | `/plan` | Current task plan |
| `GET` | `/model` | Current model and pricing |
| `GET` | `/queue` | List pending bus messages |
| `DELETE` | `/queue` | Flush bus queue |
| `POST` | `/continue` | Resume unfinished auto work |
| `POST` | `/command` | Execute REPL command |
| `POST` | `/stop` | Abort current agent execution |

Auth: a paired token (`src/security/pairing.js`), a parent's spawn secret (`AGENT_PAIRING_SECRET`), or, only with `FLINT_API_TOKEN_FILE=1`, the token from `~/.flint/api-token.json`. Without these there is no way in except pairing: no token never means no auth. Health check (`GET /status`) and pairing endpoints skip auth. CORS allows localhost with any port. Authenticated API callers get tools approved automatically (`AGENT_API_AUTO_APPROVE`, on by default); a call a hook forces to ask is refused, since nobody is there to answer.

---

## Message Bus

### `src/bus/index.js`

SQLite-backed priority queue for all input channels.

#### Priority Levels

| Constant | Value | Channel |
|---|---|---|
| `PRIORITY.USER` | 0 | TUI input, /commands |
| `PRIORITY.API` | 1 | HTTP /message |
| `PRIORITY.AGENT` | 2 | Child agent responses |
| `PRIORITY.TASK` | 3 | Scheduled tasks |
| `PRIORITY.EVENT` | 4 | Email, Telegram, external |
| `PRIORITY.SYSTEM` | 5 | BG process alerts |

#### `push(msg)` -> `{ id: number }`

Push message to queue. Fields: `channel, content, priority, source, metadata, sessionId`.

#### `drain()` -> `object|null`

Atomically pops highest-priority pending message, sets status to "processing".

#### `complete(id, result)` / `fail(id, error)` -> `void`

Mark message as done or failed.

#### `recover(staleMinutes)` -> `number`

Crash recovery: resets stale "processing" messages back to "pending".

#### `cleanup(doneHours, failedDays)` -> `{ done, failed }`

Deletes old processed/failed messages.

#### `stats()` -> `{ pending, processing, done, failed, total }`

Queue statistics.

#### `pending(limit)` / `getMessage(id)` / `recentEvents(limit)` / `cancelPending(id)`

Inspection functions, and taking back one pending message (Esc on a queued message in the console).

### `src/bus/drain-loop.js`

Single consumer that processes all messages from the bus.

#### `notify()` -> `void`

Signal that a new message is available. Uses `setImmediate` for UI render priority.

#### `waitForResult(busId, timeoutMs)` -> `Promise<{ response, stats }|{ error }>`

Used by API server for sync responses. 180s default timeout.

#### `flush()` -> `void`

Fails all pending messages and cancels self-continue timer. Sets `app.queueAborted = true`.

#### `isProcessing()` -> `boolean`

Returns true if drain loop is currently processing.

#### `getAsyncResult(busId)` -> `object|null`

Gets full result for async poll (one-time read, deleted after).

#### `resetAutonomous()` -> `void`

Clears pending self-continue timer.

### `src/bus/plugins.js`

Channel plugin loader for the bus.

#### `loadPlugins(bus)` -> `Promise<void>`

Scans the `plugins/` folder in Flint's own directory (not `~/.flint/plugins/`) for `.js` files. Each plugin must export `{ name, start(bus), stop? }`.

#### `stopPlugins()` -> `Promise<void>`

Stops all loaded plugins.

#### `listPlugins()` -> `string[]`

Returns loaded plugin names.

---

## Memory

### `src/memory/store.js`

JSONL-based persistent memory with HMAC integrity, in `memory/memories.jsonl` in Flint's own directory.

#### `insertMemory({ content, category, importance, sessionId })` -> `object`

Creates a memory entry. Content max 10000 chars. Importance 1-3. Returns the entry with auto-incremented ID.

#### `searchMemories(query, limit)` -> `Array`

Keyword-based search with importance-weighted scoring.

#### `getMemory(id)` / `listRecentMemories(limit)` / `deleteMemory(id)` / `getMemoryStats()` / `clearAllMemories()` / `invalidateCache()`

Standard CRUD operations with in-memory cache.

**Integrity**: HMAC-SHA256 with per-project key. Verifies on load, updates on write. Atomic writes via rename.

### `src/memory/tools.js`

Memory tools exposed to the agent.

| Tool | Parameters | Description |
|---|---|---|
| `memory_write` | `content, category?, importance?` | Save to persistent memory |
| `memory_search` | `query, limit?` | Search persistent memory |
| `memory_get` | `id?, last?` | Get by ID or list recent |
| `memory_delete` | `id` | Delete a memory |
| `skill_add` | `name, content, tags?` | Save a reusable procedure as a skill |
| `skill_update` | `id, content` | Replace a skill's content |
| `skill_remove` | `id` | Delete a skill |
| `memory_expand` | `id, layer?` | Full content of a skill or other memory-layer entry by ID |

### Memory layers (`src/memory/sqlite-store.js` and friends)

One SQLite database in `~/.flint/memory/` (or `<FLINT_DATA_DIR>/memory/`) holds five layers, each with its own module:

| Layer | Module | What it holds |
|---|---|---|
| 1 | `reflections.js` | Lessons extracted at session end (did / wrong / better) |
| 2 | `patterns.js` | Which tool a kind of request went to first |
| 3 | `skills.js` | Reusable procedures, also kept as markdown files in `~/.flint/memory/skills/` |
| 4 | `facts.js` | User and project facts, global or per project (`project.js`) |
| 5 | `user-model.js` | Traits of the user observed over time |

`rules.js` aggregates lessons from reflections into a ruleset, and `retrieval.js` adds per-turn hints from similar past requests. The prompt gets these sections as described under `getSystemMessage()`.

### `src/memory/session-facts.js`

Per-session fact storage in `sessions/{sessionId}.facts.jsonl`.

#### `saveSessionFact(sessionId, fact)` / `saveSessionFacts(sessionId, facts)` -> `void`

Append facts with HMAC integrity.

#### `loadSessionFacts(sessionId)` -> `Array`

Load and verify session facts.

#### `getSessionFactsSummary(sessionId, maxLines)` -> `string`

Format facts grouped by category for prompt injection.

### `src/memory/extract-facts.js`

LLM-based fact extraction from compressed messages.

#### `extractFacts(messages)` -> `Promise<Array<{ content, category }>>`

Uses the `extractionModel` (cheap/fast) to extract key facts from conversation fragments. Categories: project, tech, decision, preference, bug, person, env. Max 10 facts per fragment, 4000 char input limit.

### `src/memory/conversation-digest.js`

Deterministic per-turn log for context retention. Zero LLM cost.

#### `appendDigestEntry(sessionId, entry)` -> `void`

Appends `{ turn, ts, user, assistant, tools }` with HMAC integrity.

#### `getDigestForPrompt(sessionId, maxEntries)` -> `string`

Formats last N turns for system prompt injection.

#### `loadDigest(sessionId)` / `clearDigest(sessionId)`

Load all entries or clear.

### `src/memory/markdown.js`

Exports memory to MEMORY.md.

#### `updateMemoryMd()` -> `string`

Writes all memories grouped by category to `MEMORY.md`.

#### `readMemoryMdHead(lines)` -> `string`

Reads first N lines of MEMORY.md for system prompt injection.

### `src/memory/inbox.js`

In-memory notification inbox.

#### `pushInbox(type, content, from)` -> `void`

Types: `"reminder"`, `"message"`, `"event"`.

#### `unreadCount()` / `readInbox()` / `allInbox(limit)` / `inboxPromptHint()`

Manage notifications. `readInbox()` marks items as read. `inboxPromptHint()` returns a hint string for system prompt or null.

---

## Tasks

### `src/tasks/db.js`

SQLite database for persistent tasks.

**Location:** `~/.flint/tasks.db`, or `<FLINT_DATA_DIR>/tasks.db` (WAL mode, foreign keys on). It also holds the message bus queue.

#### Schema

**goals**: `id, title, project, status (active/completed/abandoned), session_id, created_at, completed_at`

**tasks**: `id, goal_id, title, description, status (pending/in_progress/done/skipped), priority, result, next_run, repeat, assignee, agent_port, scope (session/project/global), parent_task_id, daily_focus, created_at, updated_at`

**task_files**: `id, task_id, path, role (created/modified/related), added_at`

**task_notes**: `id, task_id, note, created_at`

**sessions**: `id, created_at, last_updated, focused_goal_id`

**message_queue**: `id, channel, content, priority, source, metadata, status (pending/processing/done/failed), session_id, created_at, processed_at, result`

#### `getDb()` -> `Database`

Lazy-initializes and returns the SQLite database with auto-migration.

#### `closeDb()` -> `void`

### `src/tasks/queries.js`

CRUD operations for tasks/goals.

**Session management:** `touchSession`, `getSession`, `setFocusedGoal`, `getFocusedGoal`, `getStaleSessions`, `gcStaleSessions`

**Goals:** `createGoal`, `getGoal`, `getActiveGoal`, `getActiveGoals`, `listGoals`, `completeGoal`, `abandonGoal`, `abandonAllActiveGoals`

**Tasks:** `createTask`, `createSubtask`, `getSubtasks`, `getTask`, `getTasksByGoal`, `updateTaskStatus`, `getNextPendingTask`, `getTaskStats`, `getTasksByGoalAndStatus`

**Task metadata:** `linkFile`, `getTaskFiles`, `addNote`, `getTaskNotes`

**Child agent tasks:** `claimTask`, `completeTaskWithResult`, `failTask`

**Scheduling:** `createReminder`, `listReminders`, `getDueReminders`, `fireReminder`, `cancelReminder`, `listRecentFired`

**Dashboard:** `getDashboard`, `getAllActivePlans`, `getProjectStats`, `goalToPlan`, `syncPlanToStore`, `getActivePlan`

**Daily focus:** `setDailyFocus`, `clearDailyFocus`, `getTodayTasks`

**Auto-complete:** Parent tasks auto-complete when all subtasks are done/skipped. Goals auto-complete when all top-level tasks are done/skipped.

---

## Security

### `src/security/index.js`

Security module orchestrator.

#### `initSecurity(store, config)` -> `{ token, delimiter, authMiddleware, stopWatchdog, policy, disabled }`

Initializes all security hooks and services. **Fails hard** (exit 78) if security can't initialize. Cannot be disabled except in test mode (`NODE_ENV=test`).

Hook registration order:
1. Path guard (beforeHook)
2. Command guard (beforeHook). The commands it makes ask come from the care level (`dangerousPatternsThatAsk()`), not from the security profile
3. Network guard (beforeHook)
4. Child policy (beforeHook)
5. Audit before hook
6. Content fence (afterHook)
7. Audit after hook

Also starts the watchdog and generates API auth token.

#### `getSecurityApi()` -> `object|null`

Returns cached security API after initialization.

### `src/security/policies.js`

Two separate settings live here: the security profile (`AGENT_SECURITY_POLICY`) and the care level (`/careful`).

#### `loadPolicy(config)` -> `object`

Returns policy object for the configured security profile.

| Field | strict | normal | permissive |
|---|---|---|---|
| blockPrivateIPs | true | true | false |
| rateLimit | 30/min | 60/min | 120/min |
| maxDepth | 2 | 5 | 10 (capped at 5 by `MAX_AGENT_DEPTH`) |
| extraDenyPaths | .bashrc etc. | none | none |

All profiles share: critical denylist (.permissions.json, .ssh, .gnupg, .aws), secret patterns (API keys, JWTs, private keys), command deny patterns (rm -rf /, fork bomb, curl|bash, etc.).

#### Care levels

`LEVELS` is `safe`, `normal`, `permissive`; `DEFAULT_ONBOARDING_LEVEL` is `normal`. `toolPermissionAtLevel(level, name, base)` decides which `confirm` tools ask, and `dangerousPatternsThatAsk(level)` which commands ask (see `src/tools/permissions.js` above). `parseLevelAnswer()` refuses anything that is not one of the three, and `SECRET_FILE_PATTERNS` names the files whose reads always ask.

### `src/security/safety-constants.js`

Hardcoded safety limits (not configurable):

| Constant | Value | Description |
|---|---|---|
| `MAX_RESULT_BYTES` | 1MB | Max tool result size |
| `MAX_AGENT_DEPTH` | 5 | Max recursive agent spawn depth |
| `MAX_MEMORY_CONTENT` | 10000 | Max memory entry length |
| `HMAC_ALGORITHM` | sha256 | Always SHA-256 |
| `ALLOW_SECURITY_DISABLE` | test only | Cannot disable in production |
| `CORE_INJECTION_PATTERNS` | 6 patterns | Core injection patterns (defined here; the content fence uses its own rule list) |

### `src/security/api-auth.js`

Token-based API authentication.

#### `generateApiToken()` -> `string`

Generates 48-char hex token (24 random bytes).

#### `masterTokenIfEnabled()` -> `string|null`

`loadOrCreateApiToken()` when `FLINT_API_TOKEN_FILE=1`, otherwise `null`: no file is read or written.

#### `loadOrCreateApiToken()` -> `string`

Loads persisted token from `~/.flint/api-token.json` (30-day TTL) or generates new one.

#### `createAuthMiddleware(token)` -> `Function`

Returns `(req, res) => boolean`. Checks: the token-file key when given (constant-time), spawn secret, paired tokens. With `token` null it still requires one of the other two. Skips auth for OPTIONS, GET /status, and /pair/* endpoints.

### `src/security/audit.js`

JSON lines audit logger in `{sessionsDir}/audit.jsonl`.

#### `initAudit(config)` / `auditLog(event, toolName, args, extra)` / `createAuditBeforeHook()` / `createAuditAfterHook()`

Auto-rotates at 10MB. Events: `TOOL_CALL`, `TOOL_RESULT`, `DENIED_*`, `CONTENT_TRUNCATED`, `SECRET_REDACTED`, `INJECTION_ATTEMPT`, `WATCHDOG_ALERT`.

### `src/security/path-guard.js`

#### `createPathGuardHook(policy)` -> `Function`

BeforeHook for file tools. Blocks writes to:
- Flint's own `src/` directory
- `.permissions.json`
- `~/.ssh`, `~/.gnupg`, `~/.aws`
- Profile-specific paths (e.g., `.bashrc` in strict mode)

Forces confirmation for any access to `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.kube` and `~/.docker`, and to files that match the secret-file patterns (`.env`, `.pem`, `.key`, etc.). Resolves symlinks before checking.

### `src/security/content-fence.js`

Unified sanitizer for all tool outputs.

#### `generateSessionDelimiter()` -> `string`

Generates `tool_result_XXXXXXXXXXXX` where X is random hex. Used to prevent delimiter injection.

#### `detectInjection(text)` -> `{ detected, score, matches }`

Multi-pattern heuristic injection detection with categorization and severity scoring. Categories: instruction_override, role_manipulation, delimiter_injection, safety_bypass, data_exfil. Includes leet-speak normalization. In the fence, score >= 2 blocks content from outside sources (web, mail, MCP); output of local tools (`LOCAL_SOURCE_TOOLS`: file reads, searches, commands, process output) is logged but not blocked.

#### `createContentFenceHook(delimiter, policy, auditFns)` -> `Function`

AfterHook pipeline:
1. Size gate (1MB hard limit)
2. Strip control characters (zero-width, RTL overrides)
3. Escape tool_result delimiters
4. Redact secrets (API keys, JWTs, private keys)
5. Injection detection and blocking (not blocked for `LOCAL_SOURCE_TOOLS`)

### `src/security/command-guard.js`

#### `createCommandGuardHook(policy)` -> `Function`

BeforeHook for `run_command` and `run_background_command`:
- **Hard deny** (every level): `rm -rf /`, fork bomb, `curl|bash`, `powershell -enc`, `format C:`, `dd of=/dev/`, `mkfs`, `del /s /q C:\`, and on Windows `Format-Volume`, `Clear-Disk`, `diskpart`, `rd /s /q` or `Remove-Item -Recurse` on a drive root. A quoted path counts as the path (`rm -rf "/"` is matched as `rm -rf /`)
- **Force confirm**, by care level: `safe` asks for every command; `normal` asks for destructive commands (`rm -r`, `git push --force`, `git reset --hard`, `git clean -f`, `npm publish`, `docker rm`, `docker system prune`, `kubectl delete`) and one-way commands (`ONE_WAY_PATTERNS`: push, publish, uploads with curl or wget, mail, scp/rsync/sftp and similar); `permissive` asks for none
- Comments and quoted text are stripped before matching, unless the command runs its argument (a shell, `eval`, an interpreter)
- An "[a]lways" answer is remembered per project (`src/tools/command-approvals.js`)

### `src/security/network-guard.js`

#### `createNetworkGuardHook(policy, agentPort)` -> `Function`

BeforeHook for `web_fetch` and `web_search`:
- Blocks private IPs (10.x, 172.16-31.x, 192.168.x, 127.x, 169.254.x, localhost) except agent's own port, in the strict and normal profiles
- Blocks non-HTTP protocols
- Sliding-window rate limiter

### `src/security/pairing.js`

PIN-based authentication protocol for peer agents.

#### `createPairingSession(fromAddress)` -> `{ sessionId, pin, expiresAt }|{ error }`

6-digit PIN, 3-minute expiry, max 3 attempts, max 5 concurrent sessions.

#### `verifyPin(sessionId, candidatePin, { name?, address? })` -> `{ valid, token? }|{ valid, error }`

Constant-time PIN comparison. On success, returns a 64-char hex bearer token and stores its SHA-256 with the name, address and time in `~/.flint/paired-clients.json`, so the pairing survives restarts.

#### `isPairedToken(token)` / `listPairedClients()` / `revokePairedClients(name | "all")` / `revokePairedToken(token)` / `revokeAllPairedTokens()`

Token management. `/paired` and `/paired revoke <name>` use the list and revoke functions.

### `src/security/persona-guard.js`

Output persona hijack detection.

#### `detectPersonaHijack(text)` -> `{ hijacked, signals }`

Detects:
- Roleplay markers (pirate, animal, robot, fantasy)
- Repeated animal/character sounds (2+ occurrences)
- Excessive emoji (>3% of text)

Strips code blocks before analysis. Triggered by 2+ signals or 3+ repeated sounds.

### `src/security/watchdog.js`

Periodic health checks (every 30s).

#### `startWatchdog(store, config, auditFns)` -> `Function`

Returns `stopWatchdog()`. Checks:
1. Heap memory usage (warns at 500MB)
2. Self-modification detection (SHA-256 hash of src/ file mtimes+sizes)

### `src/security/child-policy.js`

#### `createChildPolicyHook(policy)` -> `Function`

BeforeHook for `spawn_agent`. Blocks spawning if current depth (`AGENT_DEPTH`) >= maxDepth. Policy can lower but never exceed `MAX_AGENT_DEPTH` (5).

### `src/security/content-validator.js`

Binary content type detection via magic bytes.

#### `detectByMagicBytes(data)` -> `{ type, subtype }|null`

Detects: images (JPEG, PNG, GIF, BMP, TIFF, WebP), audio (MP3, FLAC, OGG, WAV), video (MP4, WebM, MPEG, AVI), documents (PDF), archives (ZIP, GZIP, BZIP2, XZ, 7Z, RAR), executables (PE, ELF, Mach-O, WASM, Java class), databases (SQLite).

#### `isLikelyText(data)` -> `boolean`

Returns false if >1% null bytes in first 8KB.

#### `detectBase64Content(b64)` -> `{ isBinary, detected }`

Decodes base64 and checks for binary content.

#### `validateContentType(claimedType, data)` -> `{ valid, actual, mismatch }`

Flags dangerous mismatches (claimed text/image but actually executable).

---

## MCP Client

### `src/mcp-client.js`

Connects to MCP servers, discovers tools, creates OpenAI-compatible definitions.

#### Configuration

Via `MCP_SERVERS` env var: `name|transport|url,name2|transport|url2`

Transports: `sse` (SSE), `http` (Streamable HTTP), `stdio` (subprocess)

Example: `docs|http|http://localhost:5000/mcp`

In stdio mode, servers from `--mcp-config <path>` or the folder's `.mcp.json` (`{"mcpServers": {...}}` with `type`/`url`/`headers` or `command`/`args`/`env`) are added to `MCP_SERVERS` (`parseServerConfig()`, `mcpJsonServers()`).

#### `connectMcpServers(serversEnv)` -> `Promise<{ tools, handlers, results }>`

Connects to all configured servers. Tool names are prefixed: `mcp_{serverName}_{toolName}`. Bootstrap checks every 60 s and reconnects servers that dropped.

#### `disconnectAll()` / `disconnectServer(name)` / `reconnectServer(name, serversEnv)`

Connection management.

#### `getServerStatus(serversEnv)` -> `Array<{ name, url, transport, connected }>`

#### `setMcpAbortSignal(signal)` -> `void`

Sets the abort signal for MCP calls (used by agent loop).

**Security:**
- Stdio commands from `MCP_SERVERS` must be absolute paths (a `.mcp.json` may name a command on PATH)
- Server names must be alphanumeric
- Only http/https URL schemes allowed
- 60s timeout per MCP call
- Binary content validation (blocks executables disguised as images)

---

## Providers

### `src/providers/registry.js`

Provider registry loaded from `~/.flint/providers.json` when it exists, otherwise from the bundled `config/providers.json`. The bundled file defines 7 providers: `openrouter`, `openai`, `anthropic`, `groq`, `together`, `ollama`, `gemini` (OpenAI-compatible endpoint).

#### `getProvider(id)` -> `object|null`

Returns provider config: `{ id, name, baseUrl, format, authType, defaultModel, keyRequired, modelsEndpoint, headers, ... }`.

#### `listProviders()` -> `Array`

#### `reloadProviders()` -> `object`

Hot-reload from config files.

### `src/providers/keys.js`

Encrypted API key storage in `~/.flint/keys.enc`.

**Encryption:** AES-256-GCM with PBKDF2 key derivation.
- Windows: DPAPI-protected seed -> AES key
- Linux/Mac: PBKDF2 from `~/.flint/.seed` + hostname + username

#### `getKey(providerId)` / `setKey(providerId, plaintext)` / `deleteKey(providerId)` / `hasKey(providerId)` / `listConfiguredProviders()` / `migrateEnvKey(envVarName, providerId)`

Key CRUD operations. `getKey`, `setKey`, `deleteKey` and `migrateEnvKey` are async (encryption key derivation); `hasKey` and `listConfiguredProviders` are sync.

### `src/providers/state.js`

Provider state persistence in `~/.flint/provider.json`.

#### `getActiveProvider()` / `setActiveProvider(id)` / `getLastModel(providerId)` / `setLastModel(providerId, modelId)` / `getProviderState()`

Persists active provider and last-used model per provider.

### `src/providers/models.js`

#### `fetchModels(providerId)` -> `Promise<Array<{ id, name, context_length, pricing }>>`

Fetches model list from provider API. Filters non-chat models (audio, image, embedding, etc.). Supports OpenAI-compatible, Anthropic, and Ollama formats.

#### `fetchModelInfo(providerId, modelId)` -> `Promise<{ prompt, completion, contextLength }|null>`

### `src/free-models.js`

Free mode (docs/free-mode.md). `/model free` lists OpenRouter's free models that can call tools, with speed and uptime from OpenRouter's stats; `/model free auto` picks the best with two fallbacks (`rankFree()`, `freeChain()`, `applyFreeChain()`). Counts today's free requests against the account's daily limit (`dailyFreeLimit()`, `freeUsedToday()`).

### `src/model-check.js`

Model check (docs/model-check.md). `/model test [free | <id> ...]` runs six small agent tasks with checked answers on a model in the background (`CHECK_TASKS`, `startCheckRun()`), through a stdio-mode Flint, and saves the score (`saveCheck()`), which the free list shows.

### `src/providers/adapters/openai.js`

OpenAI-compatible adapter (passthrough for OpenRouter, OpenAI, Groq, Together, Ollama, Gemini).

#### `buildHeaders(provider, apiKey)` / `buildBody(messages, model, tools, maxTokens, stream)` / `getChatUrl(provider)` / `parseStreamResponse(response, onToken)` / `parseResponse(data, onToken)`

### `src/providers/adapters/anthropic.js`

Anthropic Messages API adapter. Transforms OpenAI-format messages to Anthropic format and back.

#### `buildHeaders` / `buildBody` / `getChatUrl` / `parseResponse` / `parseStreamResponse`

Handles: system message extraction, tool_use/tool_result conversion, multimodal content, alternating-role message merging, SSE event parsing.

---

## Plugins

### `src/plugins/loader.js`

Plugin loader from `~/.flint/plugins/` (`FLINT_PLUGINS_DIR` overrides).

#### `loadPlugins()` -> `Promise<{ loaded: Array, errors: Array }>`

Loads all plugins. Each plugin directory must have `index.js`. Plugin contract:

```js
{
  name: string,
  type: "tool" | "channel" | "environment",
  version: string,
  description: string,
  tools: Array,       // OpenAI-format tool defs
  handlers: object,   // { toolName: handler }
  init?(opts): void,  // { config, store }
  destroy?(): void,
}
```

#### `listInstalledPlugins()` -> `string[]`

#### `getPluginsDir()` -> `string`

Returns `FLINT_PLUGINS_DIR` or `~/.flint/plugins/`.

### `src/plugins/manager.js`

#### `installPlugin(nameOrPath)` -> `Promise<{ ok, name?, path?, error? }>`

Installs by local path (copy) or npm package (`flint-plugin-` prefix auto-added).

#### `uninstallPlugin(name)` -> `{ ok, name?, error? }`

Removes plugin directory.

---

## Store

### `src/store/index.js`

Zustand vanilla store combining 5 slices:

```js
export const store = createStore((...args) => ({
  ...createSessionSlice(...args),
  ...createAgentSlice(...args),
  ...createUiSlice(...args),
  ...createProcessSlice(...args),
  ...createDatasetSlice(...args),
}));
```

### Slices

**session-slice.js**: `sessionId, messages, inputHistory, profile, model, provider, plan, lastSummary, pastedImages, pricing, contextLimit, lastContextTokens, sessionCost, sessionCostEstimated, sessionPromptTokens, sessionCompletionTokens, sessionCachedTokens, sessionUsageBySource` and actions: `setSession, resetSession, setProfile, setModel, setProvider, setPlan, setLastSummary, setPricing, pushMessage, addUsage, pushInputHistory`

**agent-slice.js**: `agentStatus, currentTool, activity, activityTokens, processingCount, pendingConfirmation, pendingPairing, pendingAction, toolActivities, thoughts, autoMode` and actions: `setAgentStatus, setActivity, incrementQueue, decrementQueue, setPendingConfirmation, clearPendingConfirmation, setPendingAction, addToolActivity, registerTask, unregisterTask, abortStep, escAbort, abortNext, abortAll`. `escAbort()` is what one Esc press means: end the running task and keep the queue.

**ui-slice.js**: `lines, streamText, processStreams, queuedInputs, overlay, clearCounter` and actions: `addLine, addTable, addQueuedInput, takeQueuedInput, clearQueuedInputs, setStreamText, setProcessStream, openOverlay, closeOverlay, clearScreen`. `lines` is capped at `AGENT_MAX_LINES` (1000); the console's scrollback is not.

**process-slice.js**: `processes, timers` and actions: `addProcess, finishProcess, killProcess, appendProcessOutput, killAllRunning`

**dataset-slice.js**: `datasets` and actions: `addDataset, setDatasetPage, getDatasetPage, clearDatasets`

---

## Commands

### `src/commands/registry.js`

#### `initCommands(store)` -> `void`

Registers all slash commands.

#### `isSlashCommand(input)` -> `boolean`

True when the first word is a slash and a name (`/help`, `/model`). A message that starts with an absolute path (`/work/file.mp4 ...`) is not a command.

#### `tryHandleCommand(input, store)` -> `Promise<boolean>`

Tries to match and execute a slash command. Returns true if handled.

### `src/commands/commands.js`

Slash command implementations. `/paste`, `/auto`, `/continue`, `/stop`, `/supervisor` and `/exit` are handled in `src/index.js`, which they need.

| Command | Description |
|---|---|
| `/help` | Show all commands and keys |
| `/sessions` | List saved sessions |
| `/resume` / `/resume <id>` | Pick a recent session to continue, or continue one by ID |
| `/load <id>` | Load a session |
| `/new` | Start new session (kills BG processes, abandons goals) |
| `/clear` | Clear context (keep session) |
| `/queue` | List queued messages |
| `/queue clear` | Clear bus queue |
| `/later <q>` | Queue a question for later |
| `/careful` / `/careful <level>` | Show or set the care level: safe, normal, permissive |
| `/spend` / `/spend <mode>` | Show or set the spend mode: economy, normal, generous |
| `/update` | Install a newer Flint and restart in the same session |
| `/ps` | Background processes |
| `/logs <id>` | Last output of a background process |
| `/kill <id>` / `/kill all` | Stop a background process |
| `/tools [n]` | Last n tool calls |
| `/sys` | Model, cost, context, MCP, session (renders `SystemPanel`) |
| `/plan` | Show current task plan |
| `/tasks` / `/tasks <arg>` | Task dashboard |
| `/continue` | Resume unfinished auto work |
| `/rewind` / `/rewind N` / `/rewind all` | Undo file changes |
| `/model` / `/model <id>` | Show/switch model |
| `/model free` / `/model free auto` | List free OpenRouter models / use the best with two fallbacks |
| `/model test [free \| <id> ...]` | Run the model check in the background |
| `/provider` / `/provider <id>` | Show/switch provider |
| `/key` / `/key <provider>` | Manage API keys (the key is read in secret mode) |
| `/profile` / `/profile <name>` | Switch agent profile |
| `/project [show \| set <name> \| clear]` | Show or set the project scope for memory facts |
| `/agents` | List running agent instances |
| `/mcp` | Manage MCP server connections |
| `/paste [text]` | Send the clipboard (picture or text) to the model |
| `/copy` | Copy chat output to clipboard |
| `/restart` | Restart with updated code, same session |
| `/stats` | Show current session info |
| `/budget` | Show session budget and spending |
| `/stop` | Abort the running task and drop the queue (also: typing `stop`) |
| `/exit` / `/quit` | Save the session and quit (also: `exit`) |
| `/memory` | Show persistent memory stats |
| `/memory clear` | Clear all memories |
| `/permissions` | Show tool permission map |
| `/allow <tool>` | Allow a tool without confirmation |
| `/deny <tool>` | Deny a tool completely |
| `/confirm <tool>` | Require confirmation for a tool |
| `/allow-all` | Allow all tools (YOLO mode) |
| `/deny-all` | Deny all tools |
| `/reset-permissions` | Reset to defaults |
| `/auto <task>` | Run task autonomously |
| `/plugins` | List installed plugins |
| `/install <p>` | Install a plugin |
| `/uninstall <p>` | Remove a plugin |
| `/next` / `/prev` | Navigate dataset pages |
| `/page N` | Jump to dataset page |
| `/supervisor` / `/supervisor off` | Turn the supervisor on / off |

---

## Components

React/Ink console components in `src/components/`. The console has no tabs: history is ordinary terminal scrollback, written once, and only a small live zone at the bottom is redrawn (docs/console-spec.md).

### `App.js`

Root component. Takes `store`, `onSubmit`, `onAbort` props. Renders `HistoryWriter`, `LiveZone`, the input line, `OverlayMenu` and the pending confirmation. Handles Esc, two Ctrl+C presses within 2 s to exit, Alt+V to put the clipboard (picture or text) into the input, and Ctrl+T to show or hide the session's thinking blocks.

### `HistoryWriter.js`

Prints finished lines and tables into the terminal's own scrollback.

### `LiveZone.js`

The only part that is redrawn, kept below the window height: running tool lines, messages queued during a turn, background processes, and the footer: model, cost, context as size/limit, background and queued counts, auto mode progress, care level, spend mode, today's free requests in free mode.

### `LineInput.js`

The input line with a real cursor (arrows, Ctrl+arrows, Home/End, Delete), input history and paste tokens.

### `OverlayMenu.js`

Selection list used by `/resume`, `/provider` and `/model free`.

### `CarefulMenu.js`

The first-start care-level question as a choice.

### `SystemPanel.js`

System information (model, session, context, config, MCP, plugins, datasets), rendered to text by `/sys`.

### `Table.js`

Table rendering component for dataset display.

---

## Sessions

### `src/sessions.js`

Session persistence with HMAC integrity.

#### `generateSessionId()` -> `string`

ISO timestamp format: `2026-04-08T12-30-00`.

#### `saveSession(id, data)` -> `Promise<void>`

Saves session to `sessions/{id}.json` with HMAC. Data includes: messages, model, provider, inputHistory, profile, plan, pastedImages, lastSummary, sessionCost, token counts.

#### `loadSession(id)` -> `Promise<object>`

Loads and verifies session integrity. Throws on HMAC mismatch ("possible tampering"). Auto-heals sessions from pre-HMAC versions.

#### `listSessions()` -> `Promise<Array<{ id, model, updated, userMessages, last, preview }>>`

Lists all sessions sorted by update time, with the first and the last operator message (`/resume` shows the last one).

---

## Logging

### `src/logging/logger.js`

#### `initLogger(opts)` / `createLogger(name)` -> `Logger`

JSON structured logger. Methods: `info`, `warn`, `error`, `debug`. Writes to `sessions/{sessionId}.log`.

#### `setInkActive(active)` -> `void`

Suppresses stderr writes when Ink is active.

### `src/logging/api-log.js`

Logs API calls/responses to `sessions/{sessionId}.api.log`.

### `src/logging/chat-log.js`

Logs chat lines to `sessions/{sessionId}.chat.log`.

### `src/logging/tool-log.js`

Logs tool calls and results to `sessions/{sessionId}.tools.log`.

### `src/logging/log-collector.js`

#### `startLogCollector()` -> `void`

Periodic log collector that aggregates session logs.

---

## UI

### `src/ui/header.js`

Terminal header formatting. Functions: `printHeader`, `userMsgLine`, `addIndented`, `formatToolArgs`.

### `src/ui/output.js`

Output formatting. Functions: `initOutput`, `printSystem`, `printWarning`, `printConfirm`, `printConfirmResult`, `printTable`, `printProcessStart`, `printProcessEnd`, `printProcessSummary`, `printChildAgent`, `printChildSpawn`, `printChildEvent`, `setProcessStream`.

### `src/ui/splash.js`

Splash screen animation.

---

## Other Modules

### `src/app-state.js`

Global mutable application state (`app` object): `shuttingDown`, `activeProfile`, `profileConfig`, `systemMessage`, `mcpReady`, `mcpStatusList`, `securityApi`, `autonomous`, `apiGoalId`, `queueAborted`.

### `src/message-handler.js`

#### `processMessage(content, sender)` -> `Promise<{ text, stats }>`

Core message processing: injects plan context, calls `runAgent()`, tracks costs, saves session, appends digest.

#### `handlePendingAction()` -> `Promise<void>`

Handles deferred actions (restart, clear-context) after agent response.

### `src/input-handler.js`

#### `withLock(fn)` -> `Promise`

Serializes async operations to prevent concurrent agent calls.

### `src/registry.js`

Agent instance registry for multi-instance coordination.

#### `registerAgent(pid)` / `unregisterAgent(pid)` / `listAgents()`

Tracks running Flint instances.
