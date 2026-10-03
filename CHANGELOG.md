# Changelog

All notable changes to Flint are written here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

Each version is a `## [x.y.z] - YYYY-MM-DD` heading: `/update` reads these
headings to show what changed between your version and the newest one.

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
