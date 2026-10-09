# Headless probe check — what Flint already does

Analysis of the current code (`src/model-check.js`, `src/cli.js`,
`src/index.js`, `src/headless-start.js`, `src/api/client.js`,
`src/providers/keys.js`).

## Existing model check

`src/model-check.js` already implements a **model self-check**: six small
agent tasks (`CHECK_TASKS`) whose answers a program can verify, run on a model
in stdio mode, scored and saved to `model-checks.json`.

The tasks are: create `hello.txt`, read-and-sum a file, edit JSON, run a
command (`node -e "console.log(6*7)"`), create files and list them, and
restrain (reply "ready" only). `runCheck(model)` drives an agent through all
six turns (120 s each); `startStdioAgent` spawns `bin/flint.js --print
--input-format stream-json --output-format stream-json` with its own data
folder, no MCP, all tools allowed. `setCheckAgentFactory()` lets tests
substitute the agent. The free model list uses `withScores()` to rank by a
fresh (≤14-day) score. Invoked as `/model test` (current model),
`/model test <id>`, or `/model test free`.

## What is NOT there

There is **no headless flag** that runs a *single* minimal proof and exits.
`parseCLI()` in `src/cli.js` recognises `--headless --task <task>` (full
unattended run) but nothing like `--check` or `--probe`. The model check is
invoked interactively from the agent loop via `/model test`; `runCheck`
requires a model object and runs all six tasks — it does not exit the process
with a status code, and it is not reachable from `--headless`.

## What already works (reusable pieces)

| What the flag must prove | Where it already lives |
|---|---|
| Key resolution | `src/config.js` `resolveApiKey()`, `src/providers/keys.js` `hasKey`/`getKey` — the first-run wizard (`cli.js runFirstRunSetup`) and `headlessSetupRefusal` both gate on key presence. |
| Model answer | `src/api/client.js` `fetchModelInfo`/chat completion over `src/providers/adapters/openai.js` (OpenAI-compatible, bearer or none). |
| Tool call round-trip | `src/agent/agent.js` tool loop → `src/tools/permissions.js` → `src/tools/process-tools.js` `run_command`. The check task already uses `run_command` (multi-step and run-command tasks). |
| Stdio spawn pattern | `startStdioAgent` in `src/model-check.js` — spawns `bin/flint.js --print --input-format stream-json --output-format stream-json` with isolated `FLINT_DATA_DIR`, no MCP, all tools allowed. Reused rather than duplicated. |

## Conclusion

The capability is **half-built**: `src/model-check.js` has everything needed
for the "model responds + tool call round-trip" part. The missing piece is a
headless entry point — a `--check` flag in `parseCLI()` that runs one task
(not six), prints one line, and exits with distinct non-zero codes
(10 = no key, 11 = model did not answer, 12 = tool did not run). It reuses
`startStdioAgent` and the check-task machinery rather than copying it.
