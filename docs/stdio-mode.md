# Stdio mode

Status: implemented 2026-10-02 (branch `stdio-mode`). Flint as a long-lived
subprocess driven over stream-json. The aim is that a host written for
`claude -p` stream-json can start Flint instead with the same command line and
read the same lines back, as long as it skips the lines Flint adds (see
Protocol).

## Starting it

```bash
flint --print --verbose --model <model id> \
      --input-format stream-json --output-format stream-json \
      [--session-id <id> | --resume <id>] [--dangerously-skip-permissions] \
      [--system-prompt-file <path>] [--append-system-prompt <text>] \
      [--mcp-config <path>] [--cwd <folder>]
```

`--stdio` alone means the same. `flint` (bin/flint.js) runs this mode in its
own process, without the launcher, so descriptors a host passes
(`--system-prompt-file /proc/self/fd/N`) are readable and a signal to the
process (or its group) reaches the agent itself. The model id is the provider's
(`stealth/space-bunny-alpha`, `anthropic/claude-sonnet-4.5` on OpenRouter); the
provider and key come from Flint's own `~/.flint` store or the usual
environment variables. Agent CLI flags Flint has no use for (`--add-dir`,
`--max-turns`, ...) are accepted and ignored. Another `--input-format` or
`--output-format`, or a session id with characters other than letters, digits,
`-` and `_`, exits with code 2 and the reason on stderr.

## The agent's folder

The process works in the folder it is started in (or `--cwd`):

- **Instructions**: every `CLAUDE.md` from the folder up to the root, outermost
  first, then `--system-prompt`/`--system-prompt-file`, then
  `--append-system-prompt`. They are added to Flint's own prompt as the
  agent's role and take precedence over its defaults (name, role, how to
  answer); Flint's prompt stays, because it is what describes Flint's tools.
- **MCP servers**: `.mcp.json` in the folder, or the file `--mcp-config`
  names, in the common mcpServers format: `{"mcpServers": {name: {"type": "http",
  "url", "headers"} or {"type": "stdio", "command", "args", "env"}}}`. They
  come on top of `MCP_SERVERS`. A stdio server gets the process environment
  plus its own `env`. The first turn waits up to 15 s for them to connect.
  Up to 30 of their tools are offered to the model whole
  (`FLINT_MCP_INLINE_MAX`); with more, the model gets `tool_search`, whose
  description lists every server with a few tool names, and loads what it
  needs. `FLINT_FALLBACK_ALL_TOOLS=1` offers
  them all.
- **Paths**: relative reads and writes, and commands, are in the folder.
- **Data**: sessions, the task database and memory go to `FLINT_DATA_DIR`,
  which defaults to `~/.flint` in this mode, so a host that runs each agent as
  its own user (`sudo -H -u <agent>`) gets separate data per
  agent.

## Protocol

One JSON object per line each way.

**In**

| Line | Meaning |
|------|---------|
| `{"type":"user","message":{"role":"user","content":"text"}}` | One turn. `content` may also be blocks: `text`, and `image` with a base64 or url source. |
| `{"type":"control_request","request_id":"r1","request":{"subtype":"interrupt"}}` | Stop the running turn. |

Turns run one at a time in the order they arrive. Every `control_request` is
answered with `{"type":"control_response","response":{"subtype":"success","request_id":...}}`,
whether or not something was running.

**Out**

| Line | When |
|------|------|
| `{"type":"system","subtype":"init","session_id","model","cwd","tools","mcp_servers","permissionMode","agent":"flint"}` | Once, at start. |
| `{"type":"assistant","message":{"id","role":"assistant","model","content":[text and tool_use blocks],"usage":{"input_tokens","output_tokens",...}},"session_id"}` | Each model reply, as it arrives. |
| `{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id","content","is_error"}]}}` | Each tool result (cut at 16,000 characters). |
| `{"type":"result","subtype","is_error","result","session_id","num_turns","duration_ms","total_cost_usd","usage"}` | The end of every turn. |
| `{"type":"control_response","response":{"subtype":"success" or "error","request_id",...}}` | The answer to a `control_request`. |

Those are the common stream-json lines. Flint also writes lines and fields
that the `claude` stream-json format does not have:

| Line | When |
|------|------|
| `{"type":"tool_start","tool_use_id","tool_name","args","session_id"}` | A tool begins. `tool_use_id` is the id of its `tool_use` block and of its later `tool_result`. |
| `{"type":"text","text","session_id"}` | One chunk of the reply as the model streams it, thinking left out. The same text comes again, whole, in the `assistant` line that follows. |
| `{"type":"steer_applied","request_id","source":"host","applied_to":"running_turn" or "new_turn","text","session_id"}` | A `control_request` with subtype `steer` was taken by the running turn or started a turn of its own. |

Added fields: the tool result line carries `tool_name`, `args` and
`duration_ms` (milliseconds from that call's own start) beside `message`; the
`result` line carries `stop_reason`, `truncated_at` and `provider_error`.

A host has to skip a line whose `type` it does not know and ignore fields it
does not know. One that rejects unknown types cannot read Flint as it is:
these lines are always written, there is no flag that turns them off.

`subtype` is `success` (also when the agent stopped asking after denials and
said so), `error_max_budget_usd` (Flint's cost ceiling), or
`error_during_execution` (an error, a stall, or an interrupt). After an
interrupt the session records `[Request interrupted by user ...]`, so the next
turn does not pick the stopped work up again.

Nothing else is written to stdout. Flint's own output (the lines its console
would show, warnings, logs) goes to stderr.

## Sessions

`--session-id` and `--resume` both name the session, and both continue it if
it exists and start it under that id if not. Some CLIs refuse
`--session-id` for an existing session and `--resume` for a missing one; a
host has to guess which applies, and a wrong guess there must not cost the
conversation here. A second process with the same id continues the
conversation, so a host may stop the process between turns.

## Permissions

With `--dangerously-skip-permissions` every tool runs. Without it a tool that
would ask the operator is refused at once with a message the model reads
(nobody is there to answer), and the turn goes on. The care level
(`/careful`, saved in `.permissions.json`) still decides which tools ask.

## Ending

The process exits 0 when stdin closes, after the running turn. On SIGTERM
(143), SIGINT (130), or that exit, the background processes the agent started
are killed with their children first. `restart_agent` is refused: under a
host the process cannot restart itself.

## Limits to know about

- No `stream_event` lines (`--include-partial-messages` is accepted and
  ignored). Streamed text comes as Flint's own `text` lines, see above.
- A tool that runs for minutes writes `tool_start` and then nothing until its
  result. A host with a per-line timeout should allow for that silence.
- The work of an interrupted turn is not kept in the history; the interrupt
  note is.
- The model ids are the provider's. A host passing short aliases (`sonnet`)
  has to map them.

## Using it from a host built for `claude`

A host that starts `claude` with the flags above and reads the lines above
can start Flint the same way. What changes on the host's side:

- the binary (`flint` instead of `claude`), and the model ids, which are the
  provider's (`stealth/space-bunny-alpha`);
- the credential it passes: Flint reads `OPENROUTER_API_KEY` (or another
  provider's key);
- the choice between `--session-id` and `--resume`, if the host makes one by
  looking for transcript files: with Flint either flag continues the session,
  so it can always say `--resume`.

Checked live on Windows and on Linux (Debian 12, a Python asyncio driver
shaped like such a host, 2026-10-02): role from the CLAUDE.md chain,
`.mcp.json` stdio and HTTP servers, relative paths and `pwd`, interrupt
during a running command, SIGTERM to the process group with a background
process running, `--resume` in a new process.

Tests: `tests/unit/stdio/stdio-mode.test.js` (flags, protocol, turns,
interrupts, instructions, `.mcp.json`) and
`tests/integration/stdio-process.test.js` (a real process started from another
folder: protocol lines only on stdout, exit on stdin close).
