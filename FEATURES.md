# Flint: What Can This Agent Do?

**Flint** is a terminal AI agent that reads code, edits files, runs commands, browses the web, drives desktops through MCP servers, manages tasks and remembers what it learned.

---

## Why Flint?

- A terminal console built for long work: scrollback history, a small live zone, one line per tool call
- Any LLM provider (OpenRouter, Anthropic, OpenAI, Gemini, Groq, Together, local Ollama), free models included
- Switch models mid-conversation
- Desktop and browser automation through MCP servers
- Child agents for parallel work
- Plugin SDK and MCP protocol support
- Self-hosted, runs anywhere; headless and stream-json modes for CI and hosts
- Autonomous mode with plans, spend modes, context swap for long sessions

---

## Core Capabilities

### 1. Code & Files
- Read, write, edit, search, copy, move, delete files
- Glob patterns (`**/*.js`), regex search across the codebase
- Syntax-highlighted code blocks in the terminal
- Checkpoint and rewind: undo file changes (`/rewind`)
- Context compression and context swap for long sessions (see Smart Features)

### 2. Shell & Processes
- Run shell commands (120 s timeout by default, up to 600 s per call; `AGENT_COMMAND_TIMEOUT` changes the default)
- Background processes with output kept for later reading
- Process manager: list, peek output, kill (`/ps`, `/logs <id>`, `/kill <id>`)
- Stopping a command stops its whole process tree

### 3. Web
- Fetch any URL (HTML reduced to text, 5000 characters by default)
- Web search: DuckDuckGo first, then Bing, then Google

### 4. Desktop Automation (through MCP)
- Desktop and browser tools come from an MCP server; Flint has no built-in desktop tools
- **Supervisor mode** (`/supervisor on`): watches tool calls and injects hints, for example to look before clicking on a remote desktop or to discard a recovery dialog

### 5. Multi-Agent
- Spawn child agents with different models and profiles (`spawn_agent`)
- `ask_agent` waits for the child's answer; `wait_tasks` waits for delegated work
- Each child runs on its own port with its own data folder, and stops itself after an idle timeout
- Child agents can push datasets back to the parent

### 6. Memory & Knowledge
- Persistent memory in SQLite (full-text search, plus vector search when `sqlite-vec` loads) that carries across sessions
- Skills: reusable procedures kept as markdown files under `~/.flint/memory/skills/`
- Optional Mesh integration (`MEMORY_API_URL`): semantic document search with auto-tagging
- Session facts extracted during compression, so key decisions survive

### 7. Task Planning
- Plans with goals, tasks and subtasks, notes and linked files
- SQLite-backed, survives restarts
- Autonomous mode (`/auto <task>`): the agent creates a plan and works through it; `/continue` resumes it

### 8. Multi-Provider LLM
- 7 providers: OpenRouter, OpenAI, Anthropic, Groq, Together, Gemini, Ollama (local); more can be added in `~/.flint/providers.json` (see [docs/providers.md](docs/providers.md))
- Switch with `/provider`, `/model <id>` or the `switch_model` tool
- Encrypted API key storage (AES-256-GCM, DPAPI on Windows)
- Live pricing and OpenRouter balance checking
- First-run wizard for setup

---

## Smart Features

### Tool Selection
With `INTENT_MODEL` set, a small classifier model picks the tools offered for each turn. Without it the classifier is off: every turn gets the built-in tools, MCP tools are offered whole up to a limit set by the spend mode (30 in normal), and past that through `tool_search`.

### Spend Modes (`/spend`)
`economy`, `normal` (default) and `generous` set together how many MCP tools are offered whole, when compression and swap start, and swap's sizes. The footer shows `spend: <level>`; `FLINT_SPEND` overrides. See [docs/spend-modes.md](docs/spend-modes.md).

### Compression and Context Swap
Context compresses only when it passes a threshold derived from the model's window (half of it in normal mode, capped at 128,000 tokens); `COMPRESS_AFTER_TOKENS` sets a fixed value. Before that, context swap moves big old tool results to the session folder and leaves a one-line stub; `swap_list` and `swap_read` bring them back. In long talks the oldest whole turns become one swap entry with a short summary. `FLINT_SWAP=0` turns swap off. See [docs/context-swap.md](docs/context-swap.md).

### Free Mode (`/model free`)
Lists OpenRouter's free models that can call tools, with speed and uptime from OpenRouter's stats. `/model free auto` takes the best one with two fallbacks from other vendors. The footer counts today's free requests against the account's limit. See [docs/free-mode.md](docs/free-mode.md).

### Model Check (`/model test`)
Runs six small agent tasks with checked answers on a model, in the background, and saves the score; the free list shows it. See [docs/model-check.md](docs/model-check.md).

### Care Levels (`/careful`)
`safe` (every tool whose default is to ask does, and every command), `normal` (file writes and commands run; deleting a file, child agents, MCP tools and destructive or one-way commands ask) or `permissive` (only deleting a file and `reconnect_mcp` ask). Reads never ask, except for secret files such as `.env` or SSH keys, which ask at every level, as do plugin installs. Hard blocks stay blocked at every level.

### Sessions That Continue
`/resume` picks a recent session; `/restart` and `/update` continue the same session. A resumed session shows its last 80 lines.

### Self-Update (`/update`)
Flint says when a newer version is out (at most once a day) and `/update` installs it and restarts. It refuses when there are local changes. `FLINT_UPDATE_CHECK=0` turns the check off. See [docs/self-update.md](docs/self-update.md).

### Stdio Mode
`flint --print --input-format stream-json --output-format stream-json ...` runs Flint under a host that speaks stream-json over stdin and stdout. It reads the folder's `CLAUDE.md` and `.mcp.json`. See [docs/stdio-mode.md](docs/stdio-mode.md).

---

## Security

The security layer lives in `src/security/` and is always on: `AGENT_SECURITY_DISABLE=1` is honoured only under `NODE_ENV=test`.

| Module | What it does |
|--------|-------------|
| `content-fence.js` | Content gate for every tool result: size limits, session delimiters, secret redaction, prompt injection detection |
| `content-validator.js` | Detects a file's real type by magic bytes |
| `persona-guard.js` | Checks the model's reply for signs of persona hijacking |
| `path-guard.js` | Blocks critical paths, resolves symlinks, detects secret files |
| `command-guard.js` | Blocks dangerous shell commands, asks for destructive ones |
| `network-guard.js` | Blocks requests to private IP ranges, rate limits |
| `child-policy.js` | Limits child agent nesting depth |
| `api-auth.js` | Bearer token for the HTTP API |
| `pairing.js` | PIN-based pairing for peer agents |
| `audit.js` | JSON-line audit log (`audit.jsonl` in the sessions folder) |
| `watchdog.js` | Memory usage and self-modification checks |
| `policies.js` | Security policies and care levels |
| `safety-constants.js` | Limits that no config or env var can change |
| `index.js` | Wires the hooks together |

---

## Console

There are no tabs. History is ordinary terminal scrollback, written once; only a small live zone at the bottom redraws. See [docs/console-spec.md](docs/console-spec.md).

- Each tool call is one dim ledger line (category, verb, argument, result, time)
- Each turn ends with a receipt: tools, files changed, tokens in and out, time, cost
- Footer: activity (spinner, verb, time, tokens arriving), model, cost, context size and limit, background count, care level, spend level
- Messages typed during a turn wait above the input until the agent takes them in
- Approvals show the whole command and take one key
- `/ps`, `/tools [n]` and `/sys` print what the former Processes, Tool Log and System tabs showed

**Keyboard:**
- Esc: clear the input, stop the turn, then stop background processes, newest first
- Ctrl+C: stop the turn; twice within 2 s exits
- Alt+V: paste a picture (or text) from the clipboard into the input
- Up/Down: input history
- Ctrl+U: clear the input line; Ctrl+W: delete the last word

---

## Commands

| Command | What it does |
|---------|-------------|
| `/new` | Fresh session |
| `/clear` | Clear context, keep session |
| `/sessions` | List saved sessions |
| `/resume` | Pick a recent session to continue (or `/resume <id>`) |
| `/load <id>` | Load a session |
| `/model [id]` | Show or switch the model; `/model free`, `/model test` |
| `/provider` | Show or switch the provider |
| `/key` | Manage API keys |
| `/spend` | Spend mode: economy, normal, generous |
| `/careful` | Care level: safe, normal, permissive |
| `/profile <name>` | Switch profile |
| `/auto <task>` | Autonomous mode: the agent plans and executes |
| `/continue` | Resume autonomous work |
| `/plan` | Show the current plan |
| `/tasks` | Task dashboard |
| `/supervisor` | Toggle the real-time supervisor |
| `/permissions` | Show tool permissions (`/allow`, `/deny`, `/confirm`, `/allow-all`, `/deny-all`, `/reset-permissions`) |
| `/ps`, `/logs <id>`, `/kill <id>` | Background processes |
| `/tools [n]`, `/sys` | Last tool calls; model, cost, context, MCP and session |
| `/mcp` | MCP server status |
| `/agents` | List running agent instances |
| `/rewind` | Undo file changes (`/rewind N`, `/rewind all`) |
| `/paste` | Send the clipboard (text or image) |
| `/memory` | Memory stats |
| `/plugins` | List plugins (`/install`, `/uninstall`) |
| `/update` | Install a newer Flint and restart |
| `/restart` | Restart, same session |
| `/help` | Full help |

---

## Tools (built-in, plus MCP)

The Mesh tools are registered only when `MEMORY_API_URL` is set; the swap tools are off with `FLINT_SWAP=0`.

### Files
`read_file` `write_file` `edit_file` `delete_file` `copy_file` `move_file` `create_directory` `list_directory` `glob` `search_in_files` `view_image`

### Shell & Processes
`run_command` `run_background_command` `list_processes` `kill_process` `peek_process`

### Web
`web_fetch` `web_search`

### Memory & Skills
`memory_write` `memory_search` `memory_get` `memory_delete` `memory_expand` `skill_add` `skill_update` `skill_remove`

### Mesh
`mesh_search` `mesh_add` `mesh_recent`

### Planning
`create_plan` `update_task` `list_tasks` `add_task` `add_task_note` `link_task_file` `create_subtask` `focus_goal` `task_stats` `list_goals` `today`

### Agents
`spawn_agent` `ask_agent` `list_agents` `wait_tasks`

### Control
`think` `check_balance` `list_models` `switch_model` `switch_provider` `list_providers` `list_mcp_servers` `reconnect_mcp` `restart_agent` `clear_context`

### Context, Data and Plugins
`tool_search` `swap_list` `swap_read` `show_dataset` `check_inbox` `install_plugin` `reload_plugins`

### + MCP tools
Any MCP server adds its tools. Servers come from `MCP_SERVERS`, and in stdio mode also from the folder's `.mcp.json`.

---

## Profiles

| Profile | Best for |
|---------|----------|
| **generic** | Coding, file ops, general tasks (default) |
| **generic-full** / **generic-mini** | The generic prompt with full or minimal context |
| **desktop** | GUI automation, browser, apps |
| **marketer** | Content, research, competitive analysis |
| **ux-reviewer** | UI/UX audits, accessibility |

Custom profiles: add a prompt file in `profiles/` and an entry for it in `profiles/profiles.json`.

---

## Setup

```bash
npm install -g flint-agent
flint
```

Or from the repository:

```bash
git clone https://github.com/dklymentiev/flint-agent.git
cd flint-agent
npm install
npm link
flint
```

The first run picks a provider, takes your API key and asks how careful Flint should be.

### Optional

```bash
# MCP servers
echo 'MCP_SERVERS=myserver|http|http://localhost:5000' >> .env

# Desktop profile
flint --profile desktop

# Headless mode
flint --headless --task "Fix the bug" --cwd /path/to/project
```

---

## API

HTTP server on `127.0.0.1` for external integrations. A program pairs once with a PIN shown in the console (`/paired` lists and revokes them); everything except `GET /status` and the pairing endpoints needs its `Authorization: Bearer <token>`.

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/message` | POST | Send a message; returns a message id (`?sync=true` waits for the answer) |
| `/message/:id` | GET | Poll a message's status and result |
| `/status` | GET | Model, message count, usage and cost |
| `/history` | GET | Conversation history |
| `/model` | GET | Current model and pricing |
| `/plan` | GET | Current task plan |
| `/datasets` | GET | Active datasets |
| `/dataset` | POST | Push a dataset (from a child agent) |
| `/queue` | GET | Queued messages |
| `/queue` | DELETE | Clear the queue |
| `/bus/log` | GET | Message bus log |
| `/bus/stats` | GET | Message bus counts |
| `/command` | POST | Execute a slash command |
| `/continue` | POST | Resume autonomous work |
| `/stop` | POST | Abort the current task |
| `/restart` | POST | Restart, same session |
| `/pair/request` | POST | Start pairing (the PIN is shown in the console) |
| `/pair/confirm` | POST | Confirm pairing with the PIN, returns a token |

---

## Testing

Unit and integration tests run on vitest:

```bash
npm test                  # run all tests
npm run test:unit         # unit tests
npm run test:integration  # integration tests
npm run test:watch        # watch mode
```
