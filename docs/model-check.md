# Model check (design)

Status: design, 2026-10-02.

OpenRouter tells how fast and how available a model is, not whether it can
do an agent's work. The free list ranked light models by their names; a
check measures it instead: a few small agent tasks with answers a program
can verify, run on each model, scored, saved, and used by the free list.

## The tasks

Each runs in a fresh folder; the checker reads the folder and the answer.

| # | Task | Passes when |
|---|---|---|
| 1 | Create `hello.txt` containing exactly `flint-check`. | the file holds that text |
| 2 | `data.txt` holds numbers; reply with their sum, digits only. | the answer contains the sum |
| 3 | `config.json` is `{"port": 3000, "name": "demo"}`; change the port to 8080, keep valid JSON. | it parses, port 8080, name kept |
| 4 | Run `node -e "console.log(6*7)"` and reply with its output only. | a command ran and the answer is 42 |
| 5 | Make folder `out` with `a.txt` (`A`) and `b.txt` (`B`), list it, reply with the names comma-separated. | both files right, both names in the answer |
| 6 | Reply with the word `ready` and do nothing else. | no tool call, the answer is `ready` |

Per task: passed, seconds, tool calls, failed tool calls, tokens in/out.
Score: tasks passed out of 6.

## Running

- One fresh Flint per task in stdio mode (docs/stdio-mode.md), so no task
  sees the conversation of an earlier one: its own data folder and work folder,
  no MCP servers, all tools allowed. The check waits for the agent's init event
  (FLINT_CHECK_STARTUP_S, default 120 s) and starts the next agent while the
  current task runs. 120 s per task at most (FLINT_CHECK_TASK_TIMEOUT_S).
  Nothing touches the operator's session.
- A 404 model-not-found or a 401/403 from the provider ends the check at once:
  the model is reported as "unavailable: <reason>", with no score, nothing
  saved. A run where an agent did not start is not saved either.
- `/model test` checks the current model; `/model test <id> [<id> ...]`
  those; `/model test free` every free model with tool calling. It runs in
  the background and prints one line per model as it finishes, then a table.
- A free-tier account (50 requests a day) is not run against all free models:
  a check costs about 15 requests a model. One model at a time still works.

## Results

- Saved in `model-checks.json` in the data folder: per model the date, the
  score, the per-task results.
- The free list shows the score and ranks by it: available models first, then
  higher score, then full-size before light, then speed. A score older than
  14 days is shown but not used for ranking.

## Module

`src/model-check.js`: `CHECK_TASKS` (prompt, setup, check), `runCheck(model,
{ startAgent })`, `scoreOf(results)`, `saveCheck`/`loadChecks`, and the
stdio-driven `startAgent` used by default.

## Acceptance

| # | Criterion | Test |
|---|---|---|
| M1 | Every task's check passes on a right outcome and fails on a wrong one. | `tests/unit/model-check.test.js` |
| M2 | `runCheck` drives an agent through the six tasks and records pass, time, tool calls and failed calls; a task that times out or errors fails without stopping the rest. | `model-check.test.js` |
| M3 | Results are saved and the free list ranks by a fresh score. | `model-check.test.js` |
| M4 | `/model test free` refuses on a free-tier account; `/model test <id>` runs in the background and reports. | `model-check.test.js` |
| M5 | Live: four free models checked through the real stdio mode; the table recorded in the commit. | manual |
