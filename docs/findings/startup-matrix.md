# Startup matrix: Flint started in hostile conditions

Date: 2026-10-08. Base: release/1.14.6 (33e1a7c). Windows 11, Node 20.19.4, no real console TTY
(every run spawned with piped or null stdio). Runner: `node scripts/startup-matrix.mjs [filter]`.
Each run: fresh temp data dir (FLINT_DATA_DIR), temp HOME/USERPROFILE, no real keys, 20 s hard kill.

Verdicts: OK = starts cleanly or stops with a clear message; HANG = killed by the 20 s timeout;
STACK = bare stack trace; WRONG = misleading or empty message.

| # | Scenario | Before | After |
|---|----------|--------|-------|
| 1 | `--version`, any stdin (closed / empty pipe / NUL), bin and src | OK, 0.4 s (src/index.js 7 s: loads config first) | OK (unchanged) |
| 1 | `--help` / `-h`, any stdin, bin/flint.js | HANG: first-run wizard "Choose provider (number):" | OK, usage, exit 0, 0.5 s |
| 1 | `--help` / `-h`, any stdin, src/index.js, src/launcher.js | HANG (same) | OK, usage, exit 0 |
| 2 | first run, no key, stdin not a TTY (pipe / NUL) | HANG at the wizard (watchdog lifted) | OK: one line saying what is missing and how to set key and model, exit 1, 1.4 s |
| 3 | no network (unreachable provider URL), fake key, `--headless --task x` | exit 0, JSON "API error (3x): fetch failed" (WRONG: no cause) | OK: "fetch failed [ECONNREFUSED] (provider openrouter, model x/y)" |
| 3b | `--task x` without `--headless`, fake key, stdin NUL | HANG at the careful-level menu | OK: "console needs a terminal and its input closed ... use --headless --task", exit 1 |
| 4 | no key at all, `--headless` | OK exit 1, clear line | OK (unchanged) |
| 4b | no key at all, `--check` | OK exit 10, clear line | OK (unchanged) |
| 5a | data dir empty, headless, fake key | OK | OK |
| 5b | data dir path is a file | exit 78: raw `ENOTDIR ... mkdir` (WRONG: no hint) | exit 78 plus: "point FLINT_DATA_DIR (or --data-dir) at a folder you can write to" |
| 5c | data dir with spaces and Cyrillic | OK | OK |
| 6a | corrupt provider.json | OK (silently defaults) | OK |
| 6b | corrupt ~/.flint/providers.json | OK (falls back to bundled) | OK |
| 6c | corrupt keys.enc, no env key | exit 1 "No API key configured" (WRONG: hides the damaged file) | exit 1, first a line "keys.enc cannot be read (...); treated as empty. Delete it and set the key again." |
| 6d | corrupt keys.enc, key in env | OK | OK, plus the same one-line warning |
| 6e | corrupt permissions / api-token / spend / intent / config json | OK | OK |
| 6f | `--last` with corrupt sessions | STACK: SyntaxError + `at async bootstrap` | OK: `Session "bad" could not be read (...); skipped.`, starts fresh |
| 6f | `--session bad` with corrupt file | says "not found" (WRONG) | `Session "bad" could not be read: ...`, exit 1 |
| 6g | `--list` with corrupt sessions | OK, shows "(corrupt)" | OK |
| 7 | interactive, stdin closed / empty pipe / NUL, fake key | HANG at the careful-level menu (or, once skipped, an idle "ready" screen) | OK: menu skipped; when input ends with nothing typed: one line, exit 1 |
| 8a | Ollama selected, server not running, headless | exit 0, "API error (3x): fetch failed" (WRONG) | "fetch failed [ECONNREFUSED] (provider ollama, model llama3.2)" |
| 8b | Ollama selected, interactive, stdin NUL | HANG at the menu | OK, same line as 7 |

## Root cause

`src/index.js` sets `process.stdin.isTTY = true` when stdin is not a terminal (commit 309be79, v0.2.0:
"ink requires this to not throw" because ink calls setRawMode). That fake is still needed for ink on a pipe.
But it made every later `process.stdin.isTTY` check true: `initOnboarding()` (menu) and `runFirstRunSetup()`
(readline wizard) ran against a stdin that could never answer, and `whileWaitingForOperator` had lifted the
30 s startup watchdog, so nothing ended it. Headless runs were already guarded (`headlessSetupRefusal`,
`config.headless`); the interactive entry with no terminal was not.

Fix: the fake is kept but marked (`stdin.flintFakeTTY`); `src/tty.js` `stdinIsRealTTY()` sees through it and
is what the wizard guard and `initOnboarding` use.

## Not fixed / residual

- The "loading..." spinner of the launcher shares a line with the refusal text when the child exits early
  (cosmetic, bin/flint.js path).
- `--version` through `node src/index.js` still takes 5-7 s (static imports load config first); bin/flint.js
  answers in 0.5 s.
- A fake key reaches the real OpenRouter (node's fetch ignores HTTPS_PROXY): 401 "Auth failed" comes back.
  Unreachable-provider scenarios therefore use a providers.json pointing at a closed local port.
- Port 3000 (`[server] Port 3000 error: EADDRINUSE`) is printed when another Flint on the machine holds it;
  not fatal.
- Not tested: a real Windows console TTY (needs an interactive pseudo-console, not available to a
  spawned test); the first launch on 1.14.5 as a person sees it (menu key handling, f9edc9c stale-index
  closure in CarefulMenu, whose test stays green when reverted: not touched here).
