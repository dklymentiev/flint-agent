# Security Policy

## Reporting a vulnerability

Please do not open a public issue for a security problem.

Report it privately through GitHub: on the repository page open **Security**,
then **Report a vulnerability**. Say what an attacker can do, the steps or a
proof of concept that shows it, and the Flint version (`flint --version`).

You will get an answer within a week. Once a fix is out, the report can be
made public, with credit to you if you want it.

## Supported versions

Fixes go into the latest minor release. Update with `/update` or
`npm install -g flint-agent@latest`.

| Version | Supported |
|---------|-----------|
| latest minor (1.14.x) | yes |
| older | no |

## What counts

Examples of what we want to hear about:

- A way around a guard that should hold: a command the command guard refuses
  that still runs, a write to a protected path, a `web_fetch` that reaches an
  address the network guard blocks.
- Content from outside (a web page, a mail, an MCP tool result) that makes
  Flint act without the confirmation its care level requires.
- The HTTP API answering a request without a valid token, or the token,
  API keys or the session secret leaking into logs, sessions or model
  requests.
- Encrypted keys or signed sessions that can be read or forged by someone who
  is not the user who owns them.

## Limits of the guards

Flint is an agent that runs commands and edits files with your permissions.
Its guards lower the risk; they are not a sandbox. Known limits, not bugs:

- **Pattern matching.** The command guard and the prompt-injection check
  match patterns. A determined model or a crafted input can phrase a command
  or an instruction they do not recognise. The confirmation question is the
  real gate: read it before you answer.
- **Care levels are your choice.** At `normal`, file writes and ordinary
  commands run without asking; at `permissive`, almost everything does, and
  `/allow-all` turns confirmations off. Use `safe` for work you do not want
  to watch.
- **The network guard covers `web_fetch` and `web_search`.** A shell command
  can still reach any address the machine can reach.
- **Paths.** The path guard protects Flint's own source, its permission file,
  a list of secret folders and the operating system's folders, and `AGENT_ALLOWED_PATHS` narrows the rest. It
  is not an operating system boundary: run Flint in a container or a virtual
  machine when that is what you need. The same radius extends to shell commands
  (`run_command`, `run_background_command`): literal paths that appear in the
  command text — redirections (`echo x > /etc/passwd`), `cd`, `git -C`, and
  file arguments to commands like `cat` or `rm` — are rejected if they fall
  outside the allowed directories. The check is static: it cannot see paths
  assembled from shell variables (`$VAR`), command substitution (`$(cmd)`),
  or glob patterns. For full isolation, use a container or a dedicated OS
  user.
- **Keys at rest.** API keys are encrypted (AES-256-GCM, with DPAPI on
  Windows), which keeps them out of plain files and backups. Any program
  running as the same user can still decrypt them.
- **The HTTP API** listens on 127.0.0.1 only, and a program gets in only by
  pairing with a PIN you see in the console. Paired programs get tools
  approved without asking (`AGENT_API_AUTO_APPROVE=0` turns that off), so
  pair only programs you trust and revoke them with `/paired revoke`. A
  pairing ends by itself after a day (`FLINT_PAIRING_TTL_HOURS`).
  `FLINT_API_TOKEN_FILE=1` also accepts a token file that any program
  running as your user can read; it is meant for automation, not for a
  machine you work on.
- **MCP servers and plugins** run with the same rights as Flint. Install only
  the ones you trust.
