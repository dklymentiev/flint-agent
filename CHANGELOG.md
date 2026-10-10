# Changelog

All notable changes to Flint are written here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

Each version is a `## [x.y.z] - YYYY-MM-DD` heading: `/update` reads these
headings to show what changed between your version and the newest one.

## [1.14.7] - 2026-10-09

### Fixed
- Flint installed where the user cannot write (a system install owned by root)
  did not start: "EACCES: permission denied, mkdir <install>/sessions", unless
  you already knew to set `FLINT_DATA_DIR`. Such an install now keeps its
  sessions, permissions, file memory and child-agent sessions in `~/.flint`. An
  install you can write (a checkout, a per-user npm prefix) keeps them next to
  itself as before, and `FLINT_DATA_DIR` / `--data-dir` still wins over both.
- A data folder that cannot be written is reported once, before anything else
  starts: one message with the folder and the setting that moves it, exit
  code 78. It used to surface from whichever part wrote first, as a security
  error on one machine and a stack trace on another.

## [1.14.6] - 2026-10-08

### Fixed
- The agent can read back what it just wrote. Relative paths went to a
  per-session workspace for writing, while reading, searching, listing and shell
  commands used Flint's own install folder, so a file written as `data.csv` was
  "not found" until the agent searched for it. Every file tool and shell command
  now uses one folder, the one Flint was started from (`--cwd` still wins in a
  headless run), and `write_file` answers with the full path it wrote.
- Long sessions stayed far above the compression threshold. The check measured
  the text of the messages alone and left out the system prompt and the tool
  schemas, about 18K tokens on every call. It now counts the size the provider
  reports for the previous call. One 1500-call session had spent half its calls
  above 128K tokens.
- `--data-dir` did nothing unless `FLINT_DATA_DIR` was also set: memory, the task
  database and session logs still went to the home folder. The flag is now read
  before any module chooses a path, and a relative path is made absolute once.
- A relative `--cwd` failed with "Cannot chdir" when Flint was started from a
  subfolder.
- A session lock was never released on a clean exit, so a reused process id gave
  a false "session already in use", and two processes could take the same stale
  lock. A corrupt session file is no longer replaced by an empty one: it is kept
  as `<id>.json.corrupt` and Flint says where.
- Starting without a terminal no longer hangs. `flint --help` printed nothing and
  waited; the first-run key wizard and the careful-mode menu waited for a key
  that could not come. Without a terminal Flint now says in one line what is
  missing, and an empty console input ends the run. `flint --help` prints usage.
- Clearer start-up failures instead of a stack trace or "fetch failed": a
  corrupt session is skipped by `--last` and named by `--session`; a data folder
  that is a file names the setting that fixes it; an unreachable provider names
  itself and the cause; an unreadable `keys.enc` is reported once rather than
  looking like "no key".
- A model that returns a number, a list or an object as a string for an MCP tool
  (`"100"`, `"[\"a\"]"`) is no longer rejected by validation; the string is
  converted when it parses to exactly the type the tool's schema asks for.
- "Claimed done but the repository shows no changes" appeared after turns that
  only read or searched. Only calls that can change the workspace now count, and
  `git status` is not run when there were none.
- `git stash` was blocked whenever the word `stash` appeared later in a command,
  so `git add src/stash.js` and `git branch stash-fix` were refused. Only the
  real subcommand is blocked, after git's global options.
- A tool called by a synonym (`bash` for `run_command`) was treated by the
  permission, display and swap code as an unknown tool. The real name is used
  everywhere after it is resolved, and the first use is announced once per
  session.
- The live cost counter lost the "estimated" mark and the call count when a
  provider returned no usage.
- Fact extraction used a fixed model ID that no longer exists on OpenRouter, so
  it failed silently on every message. It follows the active model and warns
  once if it cannot run.
- A provider answering 404 now says which model and provider, and what to do.
  The first-run wizard checks that the default model exists in the provider's
  list, and for Ollama that it has been pulled (`ollama pull <model>`).
- The model check could score a model 0 of 6 because its subprocess did not see
  the stored key; such an all-failed result is no longer saved. Its tests no
  longer delete the real `~/.flint/model-checks.json`.
- The window title changed width on every tick, which made the taskbar button
  jump. It is now always the same width: `<frame> Flint agent - <task>`, with
  the same gear and spark frames.
- `/memory` and other state written under a worker's home on Linux no longer
  froze its path at import time, and the approvals Flint remembers survive a
  settings save.
- Under a stdio host the provider key the host passes wins over a key saved by
  an earlier run and is not written to disk, and MCP servers started by Flint
  no longer inherit the model provider keys.
- With a data directory set, file memory (`memories.jsonl`, `MEMORY.md`) is
  kept there instead of in the install folder, and `memory_get` with a valid
  `last` no longer fails because of an invalid id passed beside it.
- The headless exit code is preserved when a command ends with a background
  process, and `&` background children no longer outlive a headless run (an
  interactive session's `&` processes are left alone).
- A headless run now exits `0` only when the task ran to its end and `2` when
  it was stopped from outside (the time limit, SIGTERM or SIGINT); a run killed
  half way used to exit `0`. `--time-limit` always stops the run, a signal that
  arrives before the first turn ends it, and the result record counts cost and
  tokens for the whole run, including an auto-verify second pass.
- `--check` runs the command the model returns through the normal permission
  check instead of executing it directly.
- A missing instructions file or a malformed `.mcp.json` at a headless start is
  one clear line and exit code 2, not a stack trace.
- A `--headless` run could wait ten minutes for an answer nobody was there to
  give. A command the guard asks about (for example `rm -r` on a scratch
  directory) held its approval prompt open for the full 600 seconds before it
  was refused. It is now refused at once, the agent is told why, and the run
  goes on. The security log records it as `DENIED_UNATTENDED`.
- Started on a terminal, as under `sudo`, a `--headless` run on a fresh
  install showed the first-run question "How careful should Flint be?" and
  waited for a key forever. A headless run no longer shows it and records no
  answer on the operator's behalf.
- With `--cwd`, the agent was told it was working in the directory Flint is
  installed in, and spent its first steps looking for the project. The system
  message now names the `--cwd` directory from the first request.
- A `--headless` run with no API key configured opened the interactive key
  wizard. It now stops with a message that says what is missing.

### Added
- Headless runs: `--time-limit` (stops, reports `stop_reason: "time"`, exit
  code 2), `--session <id>` to resume with a per-session lock, `--check` to probe
  the runtime, and a result record with model, stop reason, duration, tool and
  denied-call counts and a token breakdown (documented in
  `docs/headless-mode.md`). A headless run starts no HTTP server, keeps stdout
  and stderr clean, and takes the API key from the environment before storage.
- `--data-dir` and the `FLINT_DATA_DIR` setting choose where Flint keeps its
  state, split into a home part and an install part.
- Stdio mode emits a machine-readable event stream and accepts launch identity
  (instructions and MCP config) from the host.
- A stdio host can steer a running turn: a `control_request` with subtype
  `steer` is answered `accepted`, injected before the next model call and
  confirmed with a `steer_status` event (`delivered`, or `too_late` when the
  turn ended first). Visible text is streamed as `text_delta` events, with
  thinking left out.
- A response that stopped at the step limit says so (`truncated_at`) in the API,
  bus, stdio and headless output.
- Temporary files Flint creates (clipboard pastes, the agent `.bat`, model-check
  folders) are removed on exit and on SIGTERM/SIGINT.
- `api.log` records cached and cache-write tokens on each Usage line.
- A command-path check: shell commands that touch a path outside the allowed
  area are refused, and file tools refuse Git-Bash style `/c/...` paths on
  Windows (they used to land in a folder named `C:\c`).
- A turn that ran tools but left the repository unchanged is flagged in the
  footer (claim-versus-repository check).
- API messages can ask the agent to keep going on its own (`apiSelfContinue`,
  opt-in).

### Changed
- The default step limit per turn rises from 150 to 500, and a turn now has a
  default cost ceiling of $5 so that a long turn is not unmetered. Set
  `AGENT_MAX_COST` to change it; `0` turns it off.
- The system prompt says only what the temporary-file and relative-path handling
  does.
- A run with no operator (headless, and agents woken by a task or a letter)
  runs the tools of its configured MCP servers without asking, instead of
  refusing every call with "approval required, no operator attached". Calls a
  guard forces to be confirmed (a dangerous command, a secret file, a plugin)
  and tools the operator set to confirm or deny by rule are still refused. Set
  `FLINT_HEADLESS_MCP=ask` to keep the old refusal.

## [1.14.5] - 2026-10-04

### Fixed
- Deep in a long session, a file or page the agent had just read reached the
  model cut to its first kilobyte and a list of headings. The agent could
  report it as read and describe parts it had not seen. A new result now
  arrives whole unless it alone is bigger than the whole budget for tool
  results (32, 64 or 256 KB by spend level), and room for it is made by
  moving older results to swap.
- Small leftovers of earlier results no longer use up that budget. In a
  session with hundreds of them every new result used to be moved out one
  call after it arrived.
- Past the compression threshold (128k tokens at spend level normal) a result
  read one turn earlier was cut to its first eight and last three lines, and
  older ones to one line, with nothing to read them back from. With swap on,
  which is the default, tool results are no longer cut: a result is whole, or
  it is in swap and `swap_read` returns it.

### Changed
- Old turns of a long conversation move to swap from the compression
  threshold (half the window, at most 128k at level normal) instead of from
  300k. A long session now stays near that size instead of growing to it.
  `FLINT_SWAP_CONV_HIGH` still sets the point by hand.
- Requests to OpenRouter name the app as Flint Agent, with
  `https://flintagent.dev` as its address.

### Added
- The app icon, in `assets/icon`: the SVG and the PNG and ICO sizes built
  from it by `scripts/build-icons.mjs`.

## [1.14.4] - 2026-10-03

### Changed
- An approval prompt for an MCP tool offers `[s]`: always, for every tool of
  that server. Before, "always" covered one tool and each of a server's
  other tools asked again. A rule for a single tool still wins.
- `/allow-all` and `/deny-all` are kept by a restart of the same session
  (`/restart`, `/update`, a restart over the API). They are still never
  written to disk, and a new session starts without them.
- `/reset-permissions` also turns `/allow-all` and `/deny-all` off.

### Added
- MCP servers with headers in the console: `~/.flint/mcp.json`, in the
  common `mcpServers` format, is read at start beside `MCP_SERVERS`. A header
  value may name a secret as `${NAME}`; one that is not found stops that
  one server with a message, and no empty header is sent. Before, a server
  that wanted a token in `Authorization` could be configured only in stdio
  mode.
- `/mcp-secret <NAME>` stores such a secret in the encrypted key store,
  typed into a masked box. `${NAME}` is looked up there first and in the
  environment second.

### Fixed
- In a table, `**bold**` and `` `code` `` are shown as bold and code instead
  of with their markers, and column widths are measured on what is visible.
- A table cell too long for its column is cut to the column's width. It
  used to come out two characters wider, which pushed the row's closing bar
  onto the next line.

## [1.14.3] - 2026-10-03

### Security
- A paired program's token is accepted for a day, then the program pairs
  again. `FLINT_PAIRING_TTL_HOURS` sets another lifetime and `0` keeps
  pairings for good. Pairings made earlier expire by the same rule, and
  `/paired` shows when each one ends.

## [1.14.2] - 2026-10-02

### Fixed
- Child agents opened in their own window (`spawn_agent` with `visible`)
  stay reachable. The process that opens the window exits at once, and Flint
  took that for the agent's exit: it reported "exited", forgot the agent,
  and `ask_agent` answered "has stopped", so every question started a new
  agent. Whether such an agent is alive is now decided by its heartbeat, and
  Esc stops the agent itself rather than the long-gone window launcher.
- The API key is no longer written in plain text to a temporary `.bat` file
  when a visible child agent starts on Windows; it is passed in the
  environment.
- A piece of the "loading..." splash no longer stays on the top line of the
  console now and then: Flint waits until the splash has stopped before it
  clears the screen.

### Changed
- A child agent lives as long as its parent instead of stopping after 60
  seconds idle, so you can talk to it across several questions. It still
  stops about a minute after its parent is gone. `AGENT_CHILD_IDLE_TIMEOUT`
  turns an idle limit back on.

## [1.14.1] - 2026-10-02

### Fixed
- Free mode no longer crashes the console. After `/model free` or
  `/model free auto` chose a model, Flint stopped with React error #185, and
  then on every start, because the chosen models are remembered. The status
  line built its free-request counter as a new object on each check, so the
  screen redrew without end.
- `bin` in package.json written the way npm expects, so publishing no longer
  warns that it was corrected.

## [1.14.0] - 2026-10-02

### Added
- First public release. Flint is an AI agent for the terminal: it reads and
  edits files, runs commands, searches and fetches the web, plans and tracks
  tasks, starts child agents and remembers what it learned across sessions.
- Seven providers out of the box (OpenRouter, OpenAI, Anthropic, Gemini,
  Groq, Together, local Ollama), switched at runtime with `/provider` and
  `/model`; more can be added in `~/.flint/providers.json`. API keys are
  stored encrypted.
- Free mode (`/model free`) lists OpenRouter's free models that can call
  tools, and `/model test` scores a model on small checked tasks.
- Care levels (`/careful`) decide what asks before it runs; spend levels
  (`/spend`) decide how much context and how many tools a turn uses.
- Context swap keeps long sessions inside the model's window without
  losing old tool results.
- MCP servers over HTTP, SSE and stdio, with `tool_search` when they bring
  more tools than a turn should carry.
- HTTP API on 127.0.0.1 with a bearer token, headless runs
  (`--headless --task`) and a stream-json stdio mode for host programs.
- `/update` installs a newer version and continues the same session.

### Security
- The HTTP API lets a program in only after pairing with a PIN shown in the
  console. Pairings survive restarts (only a hash is stored) and are listed
  and revoked with `/paired`. The token file `~/.flint/api-token.json` is
  used only with `FLINT_API_TOKEN_FILE=1`.
- At start, messages an earlier run left in the queue for another session,
  or older than 10 minutes, are not run.
- Commands refused at every level now include the Windows ways to wipe a
  disk (`Format-Volume`, `Clear-Disk`, `diskpart`, `rd /s /q` or
  `Remove-Item -Recurse` on a drive root), and quoting a path no longer gets
  a refused command through (`rm -rf "/"`).
- Writes into the operating system's folders (`C:Windows`, `Program Files`,
  `/etc`, `/usr` and the like) are refused at every level, also when Flint
  runs as administrator.

### Changed
- The console starts with the FLiNT mark (titanium letters, a yellow spark
  over the i) instead of the old mascot, and the window title alternates a gear and
  a spark while Flint works.
- Flint needs Node.js 22.12 or newer. Its SQLite binding no longer builds
  for Node 20, which reached end of life in April 2026.
- The HTTP API and everything that calls it use `127.0.0.1`. On Node 22
  `localhost` resolves to `::1` first, where nothing listens, so a parent
  could not reach its child agents.
