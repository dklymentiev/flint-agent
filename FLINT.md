# Flint project rules

Rules and known traps for working on Flint's own code. Flint reads this file
as project memory when it runs in this folder, so it is written for both
people and the agent. Keep it short and current. No secrets, no machine-
specific paths.

## Layout

This is **Flint** itself: the terminal AI agent whose source you are reading.
Node.js (ESM, 20+), React/Ink console, SQLite for the message queue, tasks and
memory.

- `src/agent/`: agent loop, classifier, system-prompt builder, compression, swap
- `src/api/`: model API client and the HTTP server
- `src/bus/`: priority message queue and drain loop
- `src/commands/`: slash commands
- `src/components/`, `src/ui/`: the console
- `src/memory/`: memories, skills, session facts, memory layers
- `src/providers/`: provider registry, encrypted keys, adapters
- `src/security/`: guards, policies, audit, API auth
- `src/stdio/`: stream-json stdio mode
- `src/tools/`: built-in tools, permissions, tool registry
- `system.md`: the source of the agent's core prompt
- `config/classifier-prompt.md`: the source of the classifier's instructions
- `~/.flint/`: per-user runtime state (keys, API token, memory, tasks)

## Conventions

- **Prompts live in files, not in JS.** The agent prompt is `system.md`, the
  classifier prompt is `config/classifier-prompt.md`; the intent catalog is
  injected at runtime from `src/agent/intent-manifest.js`.
- **A fix starts with a red test.** Show the failure on the current code, then
  fix it. A check that was never seen failing proves nothing.
- **Test behaviour, not source text.** Tests that grep a source file for a
  string have passed against broken code here more than once.
- **Comments say why.** The reason, the trap, the case that made it this way.
- **A release** bumps `package.json`, adds a `## [x.y.z] - YYYY-MM-DD` section
  to `CHANGELOG.md` (the `/update` command reads those headings), then commit
  and tag.
- **No private data in tracked files**: run `bash scripts/audit-check.sh`.

## Known traps

- **A tool with no entry in `DEFAULT_PERMISSIONS` asks on every call.**
  `getPermission()` answers `"confirm"` for a name it does not know, which is
  right for a plugin or MCP tool nobody reviewed, and wrong for a first-party
  tool someone forgot. Adding a tool means adding its entry;
  `tests/unit/tools/permission-coverage.test.js` fails if you do not.
  `reconnect_mcp` is `confirm` on purpose: its argument is a server name that
  came out of an error message.
- **The care level sets tool defaults as well as command patterns.**
  `toolPermissionAtLevel()` in `src/security/policies.js` relaxes a default of
  `confirm`: `normal` runs file edits and commands without asking (the command
  guard still asks about destructive and one-way patterns), `permissive` asks
  almost nothing. `delete_file` and `reconnect_mcp` ask at every level. An
  explicit `/allow`, `/deny` or `/confirm` wins over the level, and
  `/reset-permissions` keeps the level.
- **Esc stops the task, not the step.** `escAbort()` in
  `src/store/agent-slice.js` is the whole of Esc: the step signal first (ends a
  hung model call at once), then `abortNext()`. It must never call
  `busFlush()`, which would fail a pending message as "flushed". `stop` is what
  discards the queue.
- **`patch-package` cannot re-apply over an already-patched module.** When
  tests fail on a branch where they should pass, check that `node_modules`
  matches the file in `patches/` before suspecting the code: remove the module,
  reinstall it at the patched version and run `npx patch-package`.
- **Windows line endings hide real diffs.** Two files that differ only by CRLF
  compare unequal; `diff <(tr -d '\r' < a) <(tr -d '\r' < b)` settles it.
  `git archive` from a checkout with `core.autocrlf=true` writes CRLF into
  every file: use `git -c core.autocrlf=false archive`.
- **Node 22.12+ for Flint and its tests** (`engines` in package.json).
  better-sqlite3 12.11 dropped Node 20, so an install on 20 compiles from
  source and fails without build tools; on older Node npm also skips the test
  runner's native binding without an error and vitest fails to start.
- **`web_fetch` truncates to 5000 characters** by default. Counting items in a
  JSON response belongs in a shell command (`curl` piped to `node -e`), not in
  `web_fetch`; the classifier prompt says so under "Structured data counting".
- **Classifier models invent intent names.** `src/agent/intent.js` normalises
  an unknown intent with valid tools to `complex_multi` and keeps the tools.
- **Some tests depend on the machine.** The e2e tests need `netstat`; the
  home-guard tests break if `HOME` is overridden; `own-env.test.js` needs a
  Python that Node can spawn (the Windows Store alias is skipped on purpose;
  set `FLINT_PYTHON`). A few timing-sensitive tests can fail only in the full
  run on a loaded machine; run the file alone before treating it as a bug.
