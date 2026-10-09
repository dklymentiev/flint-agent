# Headless session resume and concurrent-process locking

## What a real launch shows today

Flint runs headless with:

```
node bin/flint.js --headless --task "..." --cwd <dir> --budget <n> --port <p>
```

Session files are written to `FLINT_DATA_DIR/sessions/` (default
`~/.flint/sessions/`), one file per session id. A session id is the timestamp
`generateSessionId()` produces in `src/sessions.js`:

```js
export function generateSessionId() {
  return new Date().toISOString().slice(0, 19).replace(/[:.]/g, "-");
}
```

That is **second** precision. Two headless runs that start in the same wall-clock
second get the **same id** and write the **same file**, the second overwriting
the first.

### (a) Headless does not resume a session by id

`parseCLI()` in `src/cli.js` returns `{ action: "headless", task, cwd, budget }`
and never reads `--session`. The headless branch is matched first (it tests
`--headless`), so `--session <id>` is silently ignored and a new session is
always created. `--last` is likewise ignored for headless.

Real run, isolated data dir, first run asks the model to remember "42":

```
$ node bin/flint.js --headless --task "Remember the secret number 42. Just say ok." --cwd <dir> --budget 0.02 --port 4001
{"response":"ok","cost":0.00089451,"tokens":9937,"repoClaimGap":false}
```

That created session `2026-10-07T09-44-26.json`. A second run tries to resume
it with `--session 2026-10-07T09-44-26` and ask for the secret:

```
$ node bin/flint.js --headless --session 2026-10-07T09-44-26 --task "What is the secret number I asked you to remember?" --cwd <dir> --budget 0.02 --port 4002
{"response":"I don't have any memory of a secret number being stored. ...","cost":0.00080357,"tokens":20047,"repoClaimGap":false}
```

It did not answer "42". A new session file
`2026-10-07T09-44-33.json` was created instead, confirming `--session` is not
honored: headless always starts fresh.

### (b) Two processes on one session corrupt each other

Two headless runs launched in the same second, each with its own task:

```
P1: --task "P1 says the word ALPHA"
P2: --task "P2 says the word BETA"
```

Both finished, both `exit=0`. After both exit, `data/sessions/` contained
exactly **one** `.json` file (`2026-10-07T09-45-20.json`) — the two ids
collided. The surviving file contained `BETA` only; `ALPHA` had been
overwritten. Both processes wrote into the same file with no coordination, so
a concurrent pair silently loses one session's history.

## What is missing

1. **Headless cannot resume by id.** There is no `--session <id>` for
   `--headless`. The `resume` action (`--session` without `--headless`) is for
   the interactive console only.
2. **No mutual exclusion.** Two headless (or console) processes targeting the
   same session id run concurrently and clobber the session file. There is no
   lock file, no "refuse a second writer" guard, and no stale-lock recovery, so
   a process killed by `SIGKILL`/OOM also leaves the session half-written or, if
   a lock were added naively, permanently locked.

## Evidence captured

A red integration test
(`tests/integration/headless-session-resume-lock.test.js`) was run against the
current code and fails on both defects:

- `continues the named session instead of starting a new one` — FAILED: the
  seeded user message ("banana") was not sent to the provider; `--session <id>`
  is ignored, so a fresh session is created every time.
- `refuses the second process with a non-zero exit and a clear message` — the
  second process ran to completion instead of being locked out.
- `recovers from a stale lock left by a crashed process` — passes today only
  because no lock exists; it becomes the guard for the crash-recovery path
  once the lock is added.

## Plan

- Add `--session <id>` to the headless CLI so a headless run can continue a
  named session (one line in `src/cli.js`).
- Make `bootstrap()`'s `initSession` restore that session for `headless` action
  (`src/bootstrap.js`).
- Add a per-session lock file (`src/sessions.js`) acquired when a session is
  loaded or created: a live process refuses to start a second writer with a
  clear message and a non-zero exit; a stale lock (process gone) is recovered.
  The lock line is the one the regression test targets.
