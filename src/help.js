// `flint --help` / `-h`: the usage text, and nothing else.
//
// Why this exists: there was no --help. The flag fell through to a normal
// start, which on a machine without a key opened the first-run wizard and
// waited for a provider number; with no terminal (CI, a pipe, a host that
// probes the command) that is a hang with no way out (2026-10-08, startup
// matrix: `node src/index.js --help` waited forever with stdin from /dev/null).
// Pure and dependency-free so the three entry points (bin/flint.js,
// src/launcher.js, src/index.js) can answer before loading anything.

export const HELP_TEXT = `Flint: an AI agent for the terminal.

Usage:
  flint                          start the console (needs a terminal)
  flint --headless --task "..."  run one task without a terminal, print JSON
  flint --check                  probe key, model and tool round-trip (exit 0, 10, 11, 12)
  flint --list                   list saved sessions
  flint --version                print the version

Options:
  --provider <id>        provider to use (for example openrouter, openai, ollama)
  --model <id>           model to use
  --data-dir <path>      keep keys, sessions and state here (or set FLINT_DATA_DIR)
  --new | --last | --session <id>   start fresh, continue the last, or resume one
  --cwd <path>           headless: work in this folder
  --budget <usd>         headless: stop after this spend
  --time-limit <sec>     headless: stop after this many seconds
  --system-prompt <text> | --system-prompt-file <path>
  --append-system-prompt <text> | --append-system-prompt-file <path>
  --stdio                speak the stream-json protocol on stdin/stdout
  -h, --help             this text

First time: set a key in the environment (for example OPENROUTER_API_KEY) or run
flint in a terminal and follow the questions. Without a terminal Flint never asks:
it prints what is missing and exits.
`;

/** True when the command line asks for the usage text. */
export function wantsHelp(argv) {
  const args = argv.slice(2);
  return args.includes("--help") || args.includes("-h");
}
