# Contributing to Flint

Thank you for wanting to help. Bug reports, fixes, docs and new tools are all
welcome.

## Before you start

- For a bug, open an issue with the steps that show it, what you expected and
  what happened. `flint --version`, your OS and the provider and model you used
  help a lot.
- For a new feature or a larger change, open an issue first and say what you
  want to do, so we can agree on the shape before you spend time on it.
- Security problems go through [SECURITY.md](SECURITY.md), not public issues.

## Setting up

```bash
git clone https://github.com/dklymentiev/flint-agent.git
cd flint-agent
npm install
npm link        # optional: makes `flint` run this folder
npm test
```

Flint and its tests need Node.js 22.12 or newer: the SQLite binding has no
builds for older versions, and the test runner's native parts are skipped by
npm without an error. No API key is needed for the tests; they stub the model.

`npm run test:unit` and `npm run test:integration` run the two halves on
their own; `npx vitest run <file>` runs one file.

## Making a change

- **Show the bug before fixing it.** For a fix, add a test that fails on the
  current code first, then make it pass.
- **Keep the change about one thing.** A fix and an unrelated cleanup are two
  pull requests.
- **Comment why, not what.** The code says what it does; a comment is for the
  reason, the trap or the case that made it this way.
- **Update the docs** that describe what you changed (`README.md`,
  `docs/guide.md`, `docs/technical-reference.md` or the page for that
  feature), and add a line under `## [Unreleased]` in `CHANGELOG.md`.
- **Run the checks** before you push:

  ```bash
  npm test
  bash scripts/audit-check.sh
  ```

  `audit-check.sh` fails on private IP addresses, internal host names,
  personal e-mail addresses and home-folder paths in tracked files. Use
  `192.0.2.x`, `example.com` and `/home/user` in tests and examples.

`FLINT.md` at the root holds the project's rules and known traps. Flint reads
it as project memory when it works on its own code, and it is worth reading
before a bigger change.

## Pull requests

- Describe what changed and why, and how you checked it.
- CI runs the tests on Linux and Windows, Node 22.12 and 24; a pull request needs
  them green.
- Small commits with plain messages are easier to review than one large one.

By contributing you agree that your work is released under the
[MIT License](LICENSE).
