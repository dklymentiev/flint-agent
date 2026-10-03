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
- Not in the stdio or headless modes. `FLINT_UPDATE_CHECK=0` turns it off.

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
- `none`: says how to update by hand.
- After a successful update: restarts, continuing the session (src/restart.js).

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
