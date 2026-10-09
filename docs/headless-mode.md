# Headless Mode

`--headless` runs Flint without the TUI: it executes a single task from the
command line and exits. Every line of console UI goes to **stderr** (stdout is
reserved for the structured result). On exit, exactly one JSON object is
written to stdout.

## CLI

```
flint --headless --task "<task description>" [options]
```

| Flag | Purpose |
|------|---------|
| `--task <text>` | Required. The task for the agent to execute. |
| `--cwd <dir>` | Working directory for file tools and `git status`. |
| `--budget <n>` | Maximum spend in USD (sets `config.maxCostPerAction`). |
| `--model <id>` | Model identifier (overrides provider default). |
| `--provider <id>` | Provider identifier (see `config/providers.json`). |
| `--time-limit <n>` | Wall-clock limit in seconds, counted from the start of the task. When it passes the run ends: the model call or command in flight is aborted, commands the run started are killed, no further turn starts. |
| `--port <n>` | HTTP API port for the run. |
| `--data-dir <path>` | Directory for session/state files (defaults to `~/.flint`). |

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | The task ran to its own end (`stop_reason` `"done"`). |
| `1` | An error occurred (startup failure, unhandled exception). No record is written. |
| `2` | The run was stopped before its end and the record was still written: the `--time-limit` passed (`"time"`), or the process received SIGTERM or SIGINT (`"killed"`). Also: the launch could not be read, that is an instructions file (`--system-prompt-file`, `--append-system-prompt-file`, a `CLAUDE.md`) that cannot be opened, or a `.mcp.json` in `--cwd` that is not valid JSON. The two are told apart by stdout: a launch that could not be read writes one `[flint] ...` line to stderr and no result JSON, the same as the stdio mode does. |

One rule for a caller such as CI: `0` means the task finished, anything else
means it did not. A run that was killed half way used to exit `0`.

## Result JSON

The final stdout line is a JSON object. The set of keys is stable across all
stop paths (normal, time-limit, SIGTERM/killed); the `stop_reason` field
distinguishes how the run ended.

### Top-level keys

| Key | Type | Description |
|-----|------|-------------|
| `response` | `string` | The agent's final text response. For interrupted runs (time/killed), this is the last summary the store had. |
| `cost` | `number` | What this run spent, in USD: every model call from the start of the task to the record, on every stop path. |
| `tokens` | `number` | Prompt + completion tokens of this run. Equal to `tokens_obj.prompt + tokens_obj.completion`. |
| `repoClaimGap` | `boolean` | Whether the agent claimed to have done work but the repo had no changes (auto-verified via `git status`). |
| `model` | `string` | The model string in use, e.g. `"gpt-4o"` or `"fake-model"`. |
| `stop_reason` | `string` | How the run ended. One of: `"done"`, `"time"`, `"killed"`. |
| `duration_ms` | `number` | Wall-clock duration of the headless run in milliseconds, measured from before the first agent step to result emission. |
| `tool_calls` | `number` | Number of tool calls the agent attempted in this run (including ones that were denied, and the ones of a turn that was interrupted). |
| `denied_calls` | `number` | Number of tool calls in this run that were denied by the permission/security guard. |
| `modified_files` | `string[]` | `git status --porcelain` lines after the run, from the folder the agent worked in: `--cwd`, or without it the folder Flint was started from. Empty array if git is unavailable or the folder is not a repo. |
| `tokens_obj` | `object` | Breakdown of token usage (see below). |

### `tokens_obj`

| Key | Type | Description |
|-----|------|-------------|
| `prompt` | `number` | Prompt (input) tokens of this run. |
| `completion` | `number` | Completion (output) tokens of this run. |
| `cached` | `number` | Cached prompt tokens (subset of `prompt`) — tokens the provider served from cache rather than recomputing. |

### `stop_reason` values

| Value | Path | Exit code |
|-------|------|-----------|
| `"done"` | Normal completion — the agent finished the task and produced a final response. | `0` |
| `"time"` | The `--time-limit` passed. If the last turn had already produced its answer, `response` carries it. | `2` |
| `"killed"` | `SIGTERM` or `SIGINT` was received, at any point after startup. Before the first turn, no turn is started. The session is saved first. | `2` |

### Example

```json
{
  "response": "Done writing out.txt",
  "cost": 0.00012,
  "tokens": 1820,
  "repoClaimGap": false,
  "model": "gpt-4o",
  "stop_reason": "done",
  "duration_ms": 6340,
  "tool_calls": 3,
  "denied_calls": 0,
  "modified_files": [" M src/index.js", "?? out.txt"],
  "tokens_obj": {
    "prompt": 1500,
    "completion": 320,
    "cached": 1200
  }
}
```

## Notes for callers

- Parse the **last** line of stdout as JSON. Interleaved tool/streaming output
  is on stderr; stdout contains only the final result.
- `cost`, `tokens`, `tokens_obj`, `tool_calls` and `denied_calls` are all
  counted on one basis: the whole run, from the start of the task to the
  record. That includes a second turn Flint adds on its own (the retry after an
  edit that changed nothing) and a turn cut short by a time limit or a signal.
  A run that resumes a session (`--session`) reports its own figures, not the
  session's.
- `modified_files` uses `git status --porcelain` (not `git diff --stat`), so
  untracked files (e.g. a successful `write_file` of a new file) are included.
- `tool_calls` counts every tool call the model made in the run, including
  ones the security guard denied. `denied_calls` is the subset that was denied.
