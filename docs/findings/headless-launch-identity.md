# Headless Launch Identity

## What launch identity can be set by file or flag in `--headless` mode

Three things define a headless launch identity: **instructions** (the host prompt / system instructions), **working directory** (`--cwd`), and **MCP servers**. This was tested with real headless-bootstrap runs (calling `bootstrap()` directly with an isolated `FLINT_DATA_DIR`, `HOME`, and `--cwd`), plus real CLI invocations.

### Working directory — ✅ settable via `--cwd` flag

`parseCLI()` (src/cli.js) parses `--cwd` for headless mode. `prepareHeadless()` → `enterCwd()` calls `process.chdir(cwd)` and sets `config.projectRoot = cwd` **before** the system prompt is built, so the agent's `process.cwd()` and `config.workdir` point at the target directory.

Evidence from the real run: the system message contains `CWD: <the --cwd path>`, and file tools resolve relative paths against that directory.

### Instructions — ❌ was not settable, now fixed

Before the fix, `--system-prompt`, `--system-prompt-file`, `--append-system-prompt`, and `--append-system-prompt-file` were **not parsed** for headless mode (`parseCLI()` only handled `--task`, `--cwd`, `--budget`). `hostPromptFrom()` (which reads those flags, the CLAUDE.md chain from `--cwd`, and assembles the host instructions) was called **only for `stdio` mode** in src/index.js.

The fix:
1. `src/cli.js`: `parseCLI()` now parses the four instruction flags for `--headless` runs.
2. `src/bootstrap.js`: after `prepareHeadless()` runs (so `process.cwd()` is already the target), `bootstrap()` calls `hostPromptFrom(cli)` and loads `.mcp.json` from the cwd for headless mode — the same way `index.js` does for stdio mode.

After the fix, `--system-prompt`, `--system-prompt-file`, and the CLAUDE.md chain in `--cwd` are all read into the host prompt that precedes the agent's core identity. The host prompt text explicitly says "They take precedence over the defaults above: where they name you, give you a role, or say how to answer, follow them" (src/stdio/session.js).

### MCP servers — ✅ settable via `MCP_SERVERS` env and `~/.flint/mcp.json` file

`config.mcpServers` is populated from the `MCP_SERVERS` environment variable (parsed by `parseServerConfig()`). For non-stdio modes (including headless), `withUserMcpServers()` merges in servers from `~/.flint/mcp.json`. The fix also makes headless mode read a **local `.mcp.json`** in the `--cwd` directory, just like stdio mode does — so a headless launch is fully reproducible from the target directory alone.

Evidence: with `MCP_SERVERS="env_echo|stdio|python3 ..."` and a `~/.flint/mcp.json` containing `test_echo`, the `config.mcpServers` list contains both servers after bootstrap.

## What leaks from previous runs

### FLIGHT.md — ✅ reads from the `--cwd` directory

`formatFlintMdBlock(process.cwd())` (src/agent/project-context.js, called from system-prompt.js) walks up from `process.cwd()` looking for `FLINT.md` and injects it into **every** LLM prompt. In headless mode, `process.cwd()` is the `--cwd` target, so any `FLINT.md` present there (or in a parent directory) becomes part of the agent's prompt automatically.

### MEMORY.md — does not leak into headless runs

`readMemoryMdHead()` reads `MEMORY.md` from `config.projectRoot`. In headless mode with an isolated `FLINT_DATA_DIR` (set via `--data-dir`), `config.projectRoot` is the `--cwd` target. If a `MEMORY.md` file exists in `--cwd`, it **would** be injected. This was not observed in testing because no `MEMORY.md` existed in the temporary work directories, but the code path is active — see src/memory/markdown.js line 6: `path.join(config.projectRoot, "MEMORY.md")`.

### `~/.flint/` state directory — may leak via env / config

- `FLINT_DATA_DIR` controls the state directory. If not set, defaults to `~/.flint/`.
- `~/.flint/mcp.json`, `~/.flint/provider.json`, and `~/.flint/keys.enc` are read regardless of `--cwd`. If `FLINT_DATA_DIR` is not set, the headless run inherits the user's existing MCP servers, provider, and API key — which is how it works for every other mode.
- The Flint memory database (`~/.flint/memory/index.sqlite`) is **not** injected into the prompt as text, but `loadAll()` reads it for `memory_search`, `memory_get`, etc. — so a headless run with default `FLINT_DATA_DIR` can see memories written by previous runs.

### First-run setup — suppressed in headless mode

The first-run key wizard (`runFirstRunSetup` in cli.js) is skipped for `--headless` runs because `config.headless` is set by `markHeadless()` **before** bootstrap reaches `initOnboarding()`. If no API key is configured, the run refuses with a clear message instead of prompting — see `headlessSetupRefusal()` in src/headless-start.js.

## How to control headless launch identity

```bash
# Instructions + cwd + local MCP config from the target directory
node bin/flint.js --headless \
  --task "Fix the bug" \
  --cwd /path/to/project \
  --system-prompt "You are Pebble." \
  --system-prompt-file /path/to/instructions.txt \
  --append-system-prompt "Also prefer short answers." \
  --append-system-prompt-file /path/to/extra.txt \
  --budget 0.05

# MCP servers from the target directory (.mcp.json) or the environment
# MCP_SERVERS="server_name|stdio|command arg1 arg2"  (comma-separated for multiple)
# .mcp.json in --cwd is read automatically
```

### Isolation between headless runs

Two headless runs with different `--cwd` and `FLINT_DATA_DIR` do not see each other's instructions, CLAUDE.md, or `.mcp.json` — verified by a test that runs two isolated bootstraps and confirms the second run's host prompt does not contain the first run's instructions.
