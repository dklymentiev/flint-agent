# Self-update (design)

Status: design, 2026-10-02.

People who installed Flint learn about a new version only if someone tells
them, and update by hand (`git pull`, `npm install`). Flint tells them, and
updates on one command; it never updates on its own.

## How Flint is installed

`installKind(root)`:

- `git`: the checkout has a `.git` folder (`git clone`).
- `npm`: Flint runs from inside a `node_modules` folder (`npm i -g flint-agent`).
- `none`: anything else (a copied folder, an archive). Flint can tell that a
  newer version exists only if npm knows it, and says how to update by hand.

## Checking

At the start of an interactive session, in the background (the start does
not wait), at most once a day:

- `git`: `git fetch --tags --quiet origin`, with `GIT_TERMINAL_PROMPT=0` so a
  missing credential fails instead of waiting for a password; the newest
  `vX.Y.Z` tag is the latest version.
- `npm`/`none`: `https://registry.npmjs.org/flint-agent/latest`.
- 15 s at most; any failure is silent (logged, not shown).
- The result and the time go in `update-check.json` in the data folder, so
  the next start the same day does not check again.
- Newer than `package.json`'s version: one line in the history,
  `Flint 1.11.1 is out (you have 1.11.0). /update installs it.`
- In the console only. Not in a headless, stdio, check or list run: nobody
  reads the notice there, and a run that belongs to a program does not reach
  out to a registry on its own (`wantsUpdateCheck`). `FLINT_UPDATE_CHECK=0`
  turns it off in the console too.
- Nothing about updates asks a question, in any mode.

## /update

- Shows the current and the latest version and the CHANGELOG sections in
  between.
- `git`:
  1. Refuses, saying why, when tracked files have changes of their own
     (`git status --porcelain --untracked-files=no` is not empty), or when
     the checkout is not on `master`: an update must not overwrite anyone's
     work.
  2. `git fetch --tags origin`, then `git merge --ff-only origin/master`. If
     that cannot fast-forward, refuses and leaves things as they were.
  3. `npm install` when `package.json` or `package-lock.json` changed.
  4. If `npm install` fails: `git reset --hard <the commit it was on>`, and
     `npm install` again, so the old version still runs; says what failed.
- `npm`: `npm install -g flint-agent@latest`; failure leaves the old one.
  When the install cannot be written by this user (installed by root, as on a
  server), nothing is attempted: Flint says the install belongs to another
  user and prints the command to run, `sudo npm install -g flint-agent@latest`
  (on Windows: the same command in an administrator terminal). Flint never
  calls sudo itself, it would wait for a password.
- `none`: says it cannot update this copy and that it is updated the way it
  was put there. No advice to clone or install from npm: that would be a
  second Flint beside this one.
- After a successful update: restarts, continuing the session (src/restart.js).

## flint --update

The same update without the console, for a script or a server operator:
`flint --update` prints what it does and exits, 0 when it updated or was
already the newest, 1 otherwise. It asks the registry now rather than reading
the once-a-day cache, and it never asks the person anything.

## Acceptance

| # | Criterion | Test |
|---|---|---|
| U1 | Versions compare as numbers (1.10.0 > 1.9.1); the newest `v*` tag is found among others. | `tests/unit/update.test.js` |
| U2 | The kind of install is told from the folder. | `update.test.js` |
| U3 | The check runs at most once a day, says nothing when up to date or on failure, and one line when a newer version exists. | `update.test.js` |
| U4 | `/update` refuses with local changes, off master, or when it cannot fast-forward, and changes nothing then. | `update.test.js` |
| U5 | A git update runs fetch, fast-forward, `npm install` only when the package files changed, and restarts; a failed install goes back to the old commit. | `update.test.js` |
| U6 | The CHANGELOG sections between the two versions are shown. | `update.test.js` |
| U7 | Live: a checkout one release behind sees the notice and `/update` brings it to the latest, continuing the session. | manual, recorded in the commit |
| U8 | On an npm install this user cannot write, the update attempts nothing and names the command to run. | `update.test.js`, `scripts/install-smoke.sh` |
| U9 | No update check in a headless, stdio, check or list run; a headless turn on an out-of-date install runs and says nothing about updates. | `update.test.js`, `scripts/install-smoke.sh` |
| U10 | `flint --update` on a per-user npm install brings it to the latest release; the old session is still listed and a new turn runs. | `update.test.js`, `scripts/install-smoke.sh` |
