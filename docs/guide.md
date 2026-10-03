# Flint User Guide

Terminal AI agent with a React/Ink console, child agents, an HTTP API and persistent memory.

---

## Quick Start

```bash
npm install -g flint-agent
flint
```

From a clone: `npm install`, then `npm link` to get the `flint` command, or `npm start`.

If no API key is configured, a first-run wizard asks for a provider and a key. Keys are stored encrypted in `~/.flint/keys.enc`. `OPENROUTER_API_KEY`, `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` from the environment or `.env` are moved into that store at start; keys for the other providers are added with `/key <provider>`.

With options:
```bash
flint --profile desktop --model google/gemini-2.5-flash --port 3000 --provider openai
```

| Flag | Description |
|------|-------------|
| `--port` | HTTP server port (default 3000). Without the flag, a busy port makes Flint try the next one; with it, Flint fails instead |
| `--model` | Model ID (default: the last model used with the provider, else the provider's default) |
| `--provider` | LLM provider: openrouter, openai, anthropic, groq, together, ollama, gemini |
| `--profile` | Agent profile to load at startup |
| `--new` | Start a new session (the default) |
| `--last` | Continue the most recent session |
| `--session <id>` | Continue a given session |
| `--list` | List saved sessions and exit |
| `--headless --task "<task>" [--cwd <dir>] [--budget <usd>]` | Run one task without the console |
| `--print --input-format stream-json --output-format stream-json ...` (or `--stdio`) | Stdio mode for host programs, see [stdio-mode.md](stdio-mode.md) |
| `--version` | Print the version and exit |

See [providers.md](providers.md) for the provider list and key handling.

At the start of an interactive session Flint checks, at most once a day, whether a newer version is out and says so. `/update` installs it ([self-update.md](self-update.md)). `FLINT_UPDATE_CHECK=0` turns the check off.

---

## The Console

The console has no tabs. History is ordinary terminal scrollback: each line is written once, and scrolling, selecting and copying are the terminal's own. Only a small live zone at the bottom redraws. It holds, when present: a pending approval, the running tool with its latest output line, messages typed during a turn, up to 3 running background processes, and a preview of pasted text. Below it are the input line and the footer. Details: [console-spec.md](console-spec.md).

- Each tool call is one dim ledger line: category, verb, argument, measured result, time.
- Each turn ends with a receipt: turn number, tools, files changed, tokens in/out, time, cost.
- The footer shows the activity (`· ready` when idle; while busy a spinner and thinking, writing, running, retrying, with time and tokens arriving), then model, cost, context as size/limit, background count, queue, care level (`care:`) and spend level (`spend:`).
- A message typed while the agent works waits above the input as `queued`. It moves into history when the agent reads it, between steps.
- A paste of four or more lines or 300+ characters becomes a `[Pasted text #N]` token in the input; the model gets the full text.
- The former tabs are commands now: `/tools`, `/ps`, `/logs`, `/kill`, `/sys`.

### Keyboard

| Key | Action |
|-----|--------|
| **Enter** | Send |
| **Esc** | In order: clear the input; else take the newest unread queued message back for editing; else stop the running turn (queued messages are kept); each further press stops the newest background process, then child agents |
| **Ctrl+C** | Stop the turn (clears the input first if it has text); a second press within 2 s exits. With background processes running, the second press warns and the third exits |
| **Up / Down** | Input history |
| **Left / Right** | Move the cursor |
| **Ctrl+Left / Ctrl+Right**, **Alt+B / Alt+F** | Move by word |
| **Home / End**, **Ctrl+A / Ctrl+E** | Start / end of the input |
| **Ctrl+U** | Clear the input |
| **Ctrl+W** | Delete the last word |
| **Alt+V** | Paste the clipboard into the input: a picture becomes `[Image #N]` and is sent with the text around it. Ctrl+V does the same where the terminal passes the key through; in most terminals Ctrl+V is the terminal's own paste and sends nothing for a picture |
| **Ctrl+T** | Show or hide the model's thinking blocks of this session |
| **y / n / a** | Answer an approval: yes, no, always. Esc means no |
| **s** | On an approval for an MCP tool: always, for every tool of that server |

In the `/provider` pick list: Up/Down, Enter, Esc to go back, Ctrl+S to change the sort order.

---

## Commands

### Sessions

| Command | Description |
|---------|-------------|
| `/new` | Start a fresh session |
| `/clear` | Clear the context, keep the session |
| `/sessions` | List saved sessions |
| `/resume` | Pick a recent session to continue (or `/resume <id>`) |
| `/load <id>` | Load a session |
| `/stats` | Session, model, provider, profile, messages, tokens, cost |
| `/budget` | Session budget and spending |
| `/restart` | Restart Flint and continue the same session |
| `/update` | Install a newer Flint and restart in the same session |
| `/exit` | Quit (also `exit`, `/quit`) |

Sessions are saved as you go and keep messages, input history, profile, model, provider, cost and pasted images. A continued session shows its last 80 lines. Each message you send carries `[Local time: ...]`, so the model knows the date.

### Provider and Model

| Command | Description |
|---------|-------------|
| `/provider` | Pick a provider, then a model, from a list |
| `/provider <name>` | Switch provider (e.g. `/provider anthropic`) |
| `/key` | Show which providers have stored keys |
| `/key <provider>` | Set a key (typed in secret mode, never sent to the model) |
| `/key <provider> delete` | Delete a stored key |
| `/model` | Show the current model, provider, price and context window |
| `/model <id>` | Switch model (remembered per provider) |
| `/model free` | OpenRouter's free models that can call tools, with speed and uptime ([free-mode.md](free-mode.md)) |
| `/model free auto` | Take the best free model with two fallbacks |
| `/model test [free \| <id> ...]` | Run six small checked agent tasks on a model in the background and save the score ([model-check.md](model-check.md)) |
| `/profile <name>` | Switch agent profile |

Profiles (`profiles/profiles.json`):

| Profile | Description | Context mode |
|---------|-------------|-------------|
| generic | General-purpose assistant (the default) | full |
| generic-full | General-purpose assistant | full |
| generic-mini | General-purpose assistant | mini |
| desktop | Desktop agent with screen control | window (15) |
| marketer | Digital marketer and copywriter | window (15) |
| ux-reviewer | UX/UI specialist for terminal app review | full |

Each profile defines a system prompt, a context mode and a window size.

### How careful and how thrifty

| Command | Description |
|---------|-------------|
| `/careful` | Show or set the care level: `safe`, `normal` (default), `permissive` |
| `/spend` | Show or set the spend level: `economy`, `normal` (default), `generous` |

The care level decides which tools ask before they run. `safe` asks before every tool whose default is confirm and before every command. `normal` runs file writes and commands without asking, but still asks about deleting a file, starting or messaging a child agent, MCP tools and destructive or one-way commands (`rm -r`, `git push`, `npm publish`, uploads, mail). `permissive` asks only about deleting a file and `reconnect_mcp`. At every level, reading a secret file (`.env`, SSH keys, credentials) and installing a plugin ask, and hard blocks stay blocked. The first start asks for a level once.

The spend level sets how many MCP tools are offered whole, when old tool results are compressed and when context swap starts. `FLINT_SPEND` overrides it. Details: [spend-modes.md](spend-modes.md), [context-swap.md](context-swap.md).

### Autonomous Mode

| Command | Description |
|---------|-------------|
| `/auto <task>` | Run a task autonomously |
| `/continue` | Resume unfinished auto work |

How it works:
1. The agent creates a plan with `create_plan`.
2. It works through the tasks, calling `update_task` after each.
3. It is told to revise the plan when a step fails twice.
4. It stops at the budget limits (defaults: 50 iterations, $0.50; `AGENT_AUTO_MAX_ITERATIONS`, `AGENT_AUTO_MAX_COST`); the model is warned at 70% and 90% of the iteration limit.
5. It ends with a summary.

Safety: during auto mode the file tools are denied Flint's own folder and `.permissions.json`.

### Task Planning

| Command | Description |
|---------|-------------|
| `/plan` | Show the current task plan |
| `/tasks` | Task dashboard (active goals) |
| `/tasks all` | All goals, including completed and abandoned |

Plans are kept in SQLite (`~/.flint/tasks.db`) and persist across sessions.

### Queue

| Command | Description |
|---------|-------------|
| `/queue` | List queued messages |
| `/queue clear` | Drop queued messages |
| `/later <text>` | Queue a question or task for later |
| `stop` or `/stop` | Stop the running turn and drop the queue |

### Background Processes and Tool Calls

| Command | Description |
|---------|-------------|
| `/ps` | Background processes |
| `/logs <id>` | Output of a background process |
| `/kill <id>` | Stop a background process (`/kill all` stops all) |
| `/tools [n]` | The last n tool calls (default 20) |
| `/sys` | Model, cost, context, MCP servers, session |

### Named Datasets

| Command | Description |
|---------|-------------|
| `/next` | Next page of the last dataset |
| `/prev` | Previous page |
| `/page N` | Jump to page N |
| `/page <name> N` | Jump to page N of a named dataset |

When a tool returns a table, Flint stores it as a named dataset (`ds_1`, `ds_2`, ...). Data lives in the store and survives context compression; only a short registry goes into the system prompt. At most 10 datasets are kept (the oldest is dropped).

### Permissions

| Command | Description |
|---------|-------------|
| `/permissions` | Show the tool permission map |
| `/allow <tool>` | Run a tool without asking |
| `/deny <tool>` | Block a tool |
| `/confirm <tool>` | Ask before running a tool |
| `/allow-all` | Allow all tools. Kept in memory only; a restart of the same session keeps it, a new session starts without it |
| `/deny-all` | Deny all tools |
| `/reset-permissions` | Back to the defaults |

Three permission values:

| Value | Behavior |
|-------|----------|
| **allow** | Run without asking |
| **confirm** | Ask first. An unanswered question is refused after 10 minutes |
| **deny** | Block |

A tool's default comes from a built-in table and is then adjusted by the care level (see `/careful`). A tool not in the table, such as one from an MCP server or a plugin, defaults to confirm. Per-tool settings and "always" answers are saved to `.permissions.json` in Flint's folder. For an MCP tool the prompt also offers `[s]`, which allows every tool of that server at once (saved as `mcp_server:<name>`; a rule for a single tool still wins). `/reset-permissions` clears all of these, and `/allow-all` or `/deny-all` with them. Permission events are logged to `sessions/security.log`.

### Plugins

| Command | Description |
|---------|-------------|
| `/plugins` | List installed plugins |
| `/install <name>` | Install a plugin |
| `/uninstall <name>` | Remove a plugin |

Plugins live in `~/.flint/plugins/` (`FLINT_PLUGINS_DIR` moves them). Install from npm (the `flint-plugin-` prefix is added) or from a local path. The agent can also install and reload plugins with `install_plugin` and `reload_plugins`; both always ask unless `FLINT_PLUGIN_INSTALL=allow`.

Plugin contract:
```js
export default {
  name: "my-plugin",
  type: "tool",          // "tool" | "channel" | "environment"
  version: "1.0.0",
  tools: [/* OpenAI function definitions */],
  handlers: { tool_name: async (args) => result },
  init: async () => {},
  destroy: async () => {},
}
```

Tool results of the form `{ _table: true, columns, rows }` become paginated datasets.

### Other Commands

| Command | Description |
|---------|-------------|
| `/memory` | Persistent memory stats |
| `/memory clear` | Clear all memories |
| `/project [show \| set <name> \| clear]` | Show or set the project scope for memory |
| `/agents` | List running agent instances |
| `/mcp` | MCP server status |
| `/mcp-secret` | Tokens for MCP server headers, kept encrypted: list, `/mcp-secret <NAME>`, `/mcp-secret <NAME> delete` |
| `/paste [text]` | Send the clipboard (picture or text) to the model at once |
| `/rewind` | Undo the last file change |
| `/rewind N` | Undo the last N changes |
| `/rewind all` | Undo all changes of this session |
| `/supervisor on \| off` | Turn the supervisor (hints injected while watching tool calls) on or off |
| `/help` | Show help |

File changes are tracked by the checkpoint system (`src/tools/checkpoint.js`). Every write, edit and delete is recorded, so `/rewind` can undo it.

---

## Tools

The Mesh tools need `MEMORY_API_URL`; the swap tools are on unless `FLINT_SWAP=0`. MCP servers and plugins add more. Permissions below are the defaults before the care level is applied.

### Filesystem

| Tool | Description | Permission |
|------|-------------|------------|
| `read_file` | Read file contents | allow |
| `write_file` | Write or create a file | confirm |
| `edit_file` | Replace a text fragment in a file | confirm |
| `delete_file` | Delete a file or empty directory | confirm |
| `copy_file` | Copy a file | confirm |
| `move_file` | Move or rename a file | confirm |
| `create_directory` | Create a directory (with parents) | confirm |
| `list_directory` | List files and directories | allow |
| `glob` | Find files matching a pattern (`*`, `**`, `?`) | allow |
| `search_in_files` | Regex search across files | allow |
| `view_image` | View an image file | allow |

Reading a secret file (`.env`, `*.pem`, `id_rsa`, `credentials.json` and the like) asks at every care level.

Filesystem access can be restricted:
- `AGENT_ALLOWED_PATHS`: comma-separated list of allowed directories
- `AGENT_DENIED_PATHS`: comma-separated list of blocked directories (passed on to child agents)

### Commands and Processes

| Tool | Description | Permission |
|------|-------------|------------|
| `run_command` | Run a shell command (default timeout 120 s, `AGENT_COMMAND_TIMEOUT`; at most 600 s) | confirm |
| `run_background_command` | Run a long command in the background | confirm |
| `list_processes` | Background processes with status and PID | allow |
| `kill_process` | Stop a background process | confirm |
| `peek_process` | Last N lines of a process's output (default 10, at most 50) | allow |

Stopping a command stops its whole process tree.

### System and Web

| Tool | Description | Permission |
|------|-------------|------------|
| `web_fetch` | Fetch a URL (GET or POST with a JSON body; 5000 characters by default) | allow |
| `web_search` | Web search: DuckDuckGo, then Bing, then Google | allow |
| `think` | Step-by-step reasoning, not shown to the user | allow |
| `check_balance` | OpenRouter credit balance and usage | allow |
| `list_models` | Models of the current provider with pricing | allow |
| `switch_model` | Switch model (optionally the provider too) | allow |
| `switch_provider` | Switch provider | allow |
| `list_providers` | Providers and which have keys | allow |
| `list_mcp_servers` | MCP servers and their connection status | allow |
| `reconnect_mcp` | Reconnect an MCP server by name | confirm |
| `restart_agent` | Restart Flint, same session | confirm |
| `clear_context` | Clear the conversation history | confirm |

### Memory and Skills

| Tool | Description | Permission |
|------|-------------|------------|
| `memory_write` | Save a fact or decision to persistent memory | allow |
| `memory_search` | Search memory | allow |
| `memory_get` | Get a memory by ID | allow |
| `memory_delete` | Delete a memory | allow |
| `memory_expand` | Get the full text of a skill or memory entry by ID | allow |
| `skill_add` | Save a repeatable procedure as a skill | allow |
| `skill_update` | Update a skill | allow |
| `skill_remove` | Remove a skill | allow |

Skills are markdown files in `~/.flint/memory/skills/`. Session facts are extracted during context compression and restored when a session is loaded.

### Mesh Memory (only with `MEMORY_API_URL`)

| Tool | Description | Permission |
|------|-------------|------------|
| `mesh_search` | Semantic search with tag filtering | allow |
| `mesh_add` | Save a document with auto-tagging | allow |
| `mesh_recent` | Recent documents | allow |

An external semantic document store, registered only when `MEMORY_API_URL` is set.

### Task Planning

| Tool | Description | Permission |
|------|-------------|------------|
| `create_plan` | Create a plan: a goal and tasks | allow |
| `update_task` | Set a task's status (done, in_progress, skipped) | allow |
| `list_tasks` | The plan with task statuses | allow |
| `add_task` | Add a task to the plan | allow |
| `create_subtask` | Add a subtask | allow |
| `add_task_note` | Add a note to a task | allow |
| `link_task_file` | Link a file to a task | allow |
| `focus_goal` | Make a goal the active one | allow |
| `list_goals` | List goals | allow |
| `task_stats` | Task counts by status | allow |
| `today` | Show or set today's tasks | allow |

### Child Agents

| Tool | Description | Permission |
|------|-------------|------------|
| `spawn_agent` | Start a child agent in a separate process with a task | confirm |
| `ask_agent` | Send a message to a child agent and wait for its answer | confirm |
| `list_agents` | Child agents with status, port and task | allow |
| `wait_tasks` | Wait until all tasks of a goal are done or skipped | allow |

```
spawn_agent(task: "research competitors", profile: "marketer", port: 3012)
ask_agent(port: 3012, message: "focus on pricing pages")
list_agents()
```

- Each child runs on its own HTTP port (auto-assigned from 3010 if not given) and has its own data folder.
- `spawn_agent` also takes `model`, `task_id` (a task the child claims and reports on) and `visible` (open a console window).
- Children inherit `AGENT_DENIED_PATHS`. At most `AGENT_MAX_CHILDREN` (default 5) run at once.
- A child lives as long as its parent and stops about a minute after the parent is gone. `AGENT_CHILD_IDLE_TIMEOUT` makes it also stop after that many seconds idle (default 0, off), but not while it works.
- Children can push datasets to the parent with `POST /dataset`.
- The agent registry (`src/registry.js`) tracks running instances.

### Other Tools

| Tool | Description | Permission |
|------|-------------|------------|
| `tool_search` | Find and load tools not offered whole (many MCP tools) | allow |
| `swap_list` | List tool results moved out of the context ([context-swap.md](context-swap.md)) | allow |
| `swap_read` | Read one back | allow |
| `show_dataset` | Go to a page of a named dataset | allow |
| `check_inbox` | Read unread notifications | allow |
| `install_plugin` | Install a plugin | confirm |
| `reload_plugins` | Reload plugins | confirm |

`swap_list` and `swap_read` are not offered when `FLINT_SWAP=0`.

---

## MCP Integration

Connect MCP (Model Context Protocol) servers with an environment variable:

```bash
MCP_SERVERS=myserver|http|http://localhost:5000,legacy|sse|http://localhost:8080/sse,local|stdio|my-mcp-server --flag
```

Format: `name|transport|url-or-command`, comma-separated.

| Transport | Description |
|-----------|-------------|
| `http` | Streamable HTTP |
| `sse` | Server-Sent Events (legacy) |
| `stdio` | A local command started as a subprocess |

A server that needs a header, such as a token in `Authorization`, goes into `~/.flint/mcp.json` (under `FLINT_DATA_DIR` if you set it), in the common `mcpServers` format:

```json
{
  "mcpServers": {
    "analytics": {
      "type": "http",
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer ${ANALYTICS_TOKEN}" }
    }
  }
}
```

`${NAME}` in a header is a secret kept outside the file. Store it with `/mcp-secret NAME`: the value is typed into a masked box, never shown again, and kept in Flint's encrypted key store beside the provider keys (`/mcp-secret` lists the names, `/mcp-secret NAME delete` removes one). A name that is not in the key store is taken from the environment (`.env` included). If it is in neither, that server is not connected and its status says which name is missing; the header is never sent empty. Servers from this file are connected together with those from `MCP_SERVERS`; one named in both is taken from the file. `/mcp` does not show header values.

In stdio mode Flint reads `.mcp.json` from the working folder (or the file `--mcp-config` names) instead of `~/.flint/mcp.json`; `${NAME}` works there too.

MCP tools are named `mcp_<server>_<tool>` and registered beside the built-in tools. A dropped server is reconnected automatically every 60 s. With many MCP tools, a set number is offered whole (30 at the normal spend level) and the rest through `tool_search`. `/mcp` shows status; the agent can call `list_mcp_servers` and `reconnect_mcp`.

---

## Security

The security module (`src/security/`) starts with Flint. A program gets into the HTTP API only by pairing: you see its PIN in the console and give it to the program. `/paired` lists paired programs and revokes them.

### Security Policies

Separate from the care level, the policy sets path, network and nesting limits.

| Policy | Description |
|--------|-------------|
| **strict** | Also blocks writes to shell startup files in the home folder (.bashrc, .profile, ...); agent depth 2; 30 requests/min |
| **normal** | Default. Critical path protection; agent depth 5; 60 requests/min |
| **permissive** | No forced questions for dangerous commands, private IPs not blocked; 120 requests/min |

Set with `AGENT_SECURITY_POLICY`. Agent depth is capped at 5 whatever the policy says.

### Security Components

| Component | What it does |
|-----------|-------------|
| **path-guard** | Blocks writes to `.ssh`, `.gnupg`, `.aws`, `.permissions.json`; resolves symlinks |
| **command-guard** | Blocks `rm -rf /`, fork bombs, `curl \| bash`, `dd of=/dev/`, `mkfs`, `format C:` and the Windows equivalents (`Format-Volume`, `Clear-Disk`, `diskpart`, a recursive delete of a drive root), quoted or not; asks before dangerous commands per care level |
| **content-fence** | Session-unique delimiters around outside content, secret redaction (API keys, JWTs, private keys), prompt-injection detection |
| **content-validator** | Detects a file's real type by its magic bytes, whatever its name claims |
| **network-guard** | Blocks private IPs (strict and normal) and non-HTTP protocols, rate limiting |
| **api-auth** | Bearer tokens for the HTTP API: paired programs, a parent's spawn secret, and the token file only with `FLINT_API_TOKEN_FILE=1`. `GET /status` and the pairing endpoints are open |
| **pairing** | PIN pairing for other agents to get a token |
| **audit** | JSON-line audit log (`sessions/audit.jsonl`, rotated at 10 MB) |
| **watchdog** | Every 30 s: memory (warns at 500 MB heap) and changes to Flint's own source |
| **child-policy** | Limits agent nesting depth |
| **persona-guard** | Checks the agent's answers for signs that its role was hijacked |

### API Authentication

Every endpoint except `GET /status` and `/pair/*` needs `Authorization: Bearer <token>`. A program gets its token by pairing once:

```bash
# 1. Ask. The console shows "Pairing request from my-script@127.0.0.1 -- PIN: 123456".
curl -X POST http://127.0.0.1:3000/pair/request -d '{"agentName":"my-script"}'
# -> {"sessionId":"...","expiresAt":...}
# 2. Confirm with the PIN from the console, within 3 minutes (3 tries).
curl -X POST http://127.0.0.1:3000/pair/confirm -d '{"sessionId":"...","pin":"123456"}'
# -> {"token":"..."}  keep it: it works across restarts until revoked
TOKEN=<the token>
curl -X POST http://127.0.0.1:3000/message \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"content": "hello"}'
```

---

## HTTP API

Listens on `127.0.0.1`, port 3000 by default. CORS allows `localhost` and `127.0.0.1` origins on any port.

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/message` | Send a message. Body: `{ content, name?, sync? }`. Returns a `messageId` at once; with `?sync=true` waits for the answer (up to 180 s) |
| GET | `/message/:id` | Status and result of a message: response, stop_reason, tool calls |
| GET | `/status` | Model, message count, usage and cost (no token needed) |
| GET | `/history` | Conversation messages (`?limit`, `?offset`) |
| GET | `/model` | Current model and price per 1M tokens |
| GET | `/plan` | Current task plan |
| GET | `/datasets` | Datasets with pagination info |
| POST | `/dataset` | Push a dataset (from a child agent). Body: `{ label, columns, rows }` |
| GET | `/queue` | Queued messages |
| DELETE | `/queue` | Drop queued messages |
| GET | `/bus/log` | Recent message bus events (`?limit`) |
| GET | `/bus/stats` | Message bus counters |
| POST | `/command` | Run a slash command. Body: `{ command }` (e.g. "/clear") |
| POST | `/continue` | Same as `/continue` |
| POST | `/stop` | Stop the running task |
| POST | `/restart` | Restart, same session |
| POST | `/pair/request` | Start PIN pairing (no token needed) |
| POST | `/pair/confirm` | Confirm the PIN and get a token (no token needed) |

Tools called through the API run without asking (`AGENT_API_AUTO_APPROVE=0` turns that off). Plugin installs still ask. That is why nothing gets in without pairing: `/paired` lists paired programs, `/paired revoke <name>` (or `all`) removes them. Only the hash of each token is stored, in `~/.flint/paired-clients.json`. A pairing lasts a day and survives restarts within it; after that the program pairs again. `FLINT_PAIRING_TTL_HOURS` sets another lifetime, and `0` means pairings do not expire. `/paired` shows when each one ends.

Automation that starts its own Flint can set `FLINT_API_TOKEN_FILE=1`: Flint then also accepts the token it writes to `~/.flint/api-token.json` (renewed after 30 days). Any program running as your user can read that file, so leave it off on a machine you work on.

Messages wait in a queue that survives restarts. At start, messages an earlier run left for another session, or older than 10 minutes, are not run; the console says how many. Reminders are kept.

---

## Configuration

Set in the environment or in `.env` in Flint's folder. Selected variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` | none | Provider keys, moved into the encrypted store at start |
| `FLINT_PROVIDER` | `openrouter` | Provider (else the last one chosen) |
| `OPENROUTER_MODEL` | provider default | Model ID, for any provider |
| `OPENROUTER_PROVIDER_ONLY`, `_IGNORE`, `_ORDER`, `_SORT` | none | OpenRouter host routing for the main model |
| `INTENT_MODEL` | none | Classifier model that picks the tools per turn. Unset: the classifier is off |
| `FLINT_SPEND` | none | Spend level, overrides `/spend` |
| `FLINT_SWAP` | on | `0` turns context swap off |
| `FLINT_DATA_DIR` | none | Where sessions, tasks and memory go |
| `FLINT_UPDATE_CHECK` | on | `0` turns the update notice off |
| `FLINT_PLUGIN_INSTALL` | `ask` | `allow` lets the agent install plugins without asking |
| `FLINT_SELF_VERIFY` | `off` | `on` adds a round that asks the model to check a change it made |
| `AGENT_MAX_RESPONSE_TOKENS` | `16384` | Max tokens per model response |
| `AGENT_MAX_ITERATIONS` | `150` | Max steps per turn |
| `AGENT_MAX_COST` | `0` (no limit) | Max cost per message, USD |
| `AGENT_SESSION_BUDGET` | `0` (no limit) | Max cost per session, USD |
| `AGENT_AUTO_MAX_ITERATIONS` | `50` | Auto mode step limit |
| `AGENT_AUTO_MAX_COST` | `0.50` | Auto mode cost limit, USD |
| `AGENT_MAX_LINES` | `1000` | Lines kept in the console's line buffer |
| `AGENT_MAX_RESPONSE_LINES` | `500` | Max lines of one answer shown |
| `AGENT_ALLOWED_PATHS` | none | Comma-separated allowed directories |
| `AGENT_DENIED_PATHS` | none | Comma-separated blocked directories |
| `AGENT_WORKDIR` | none | Working folder for relative paths in file tools |
| `AGENT_SHELL` | bash (Git Bash on Windows) | Shell for `run_command` |
| `AGENT_MAX_CHILDREN` | `5` | Max child agents at once |
| `AGENT_CHILD_IDLE_TIMEOUT` | `0` | Seconds before an idle child stops; 0 = never, it lives as long as its parent |
| `AGENT_PROFILE` | `generic` | Profile at start (same as `--profile`) |
| `AGENT_API_AUTO_APPROVE` | on | `0`: API callers get approval questions too |
| `FLINT_API_TOKEN_FILE` | off | `1`: also accept the token in `~/.flint/api-token.json` (automation; see API Authentication) |
| `FLINT_PAIRING_TTL_HOURS` | `24` | How long a paired program's token is accepted, in hours; `0`: pairings do not expire |
| `MCP_SERVERS` | none | MCP servers (`name\|transport\|url,...`) |
| `MEMORY_API_URL` | none | Mesh memory API endpoint |
| `AGENT_SECURITY_POLICY` | `normal` | `strict`, `normal` or `permissive` |

---

## Source Layout

```
bin/flint.js        the flint command
src/launcher.js     starts Flint and restarts it on exit code 42
src/index.js        entry: console, input handling, headless and stdio modes
src/bootstrap.js    startup: profile, tools, MCP, plugins, server, session
src/agent/          the agent loop, auto mode, compression, swap, classifier, system prompt
src/api/            model API client and the HTTP server
src/bus/            message queue and drain loop
src/commands/       slash commands
src/components/     the console (Ink): App, LineInput, LiveZone, HistoryWriter, ...
src/ui/             output helpers, header, tool ledger, paste tokens
src/providers/      provider registry, encrypted keys, model lists, adapters
src/tools/          built-in tools, permissions, checkpoints, tool registry
src/memory/         memory, skills, session facts
src/tasks/          SQLite task database
src/security/       guards, policies, audit, API auth, pairing
src/stdio/          stdio (stream-json) mode
src/plugins/        plugin loader and installer
src/store/          Zustand state slices
config/             providers.json, curated models, classifier prompt
profiles/           agent profiles
```
