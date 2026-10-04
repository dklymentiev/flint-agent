# Changelog

All notable changes to Flint are written here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

Each version is a `## [x.y.z] - YYYY-MM-DD` heading: `/update` reads these
headings to show what changed between your version and the newest one.

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
