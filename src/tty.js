// Is there a person at a terminal? index.js has to answer that honestly, and it
// cannot answer from process.stdin.isTTY alone.
//
// index.js sets process.stdin.isTTY = true (git log -S: v0.2.0) when stdin is
// not a terminal, because ink calls setRawMode on stdin and throws on a pipe;
// the fake keeps `echo ... | flint`, CI and a host's pipe from crashing the
// console. It also made every later `if (!process.stdin.isTTY)` check
// meaningless: with stdin from /dev/null the first-run wizard and the
// "How careful should Flint be?" menu were drawn and waited for keys that could
// never come (2026-10-08: `node src/index.js --help` hung; the 1.14.5 tester's
// first launch hung). The fake stays, because ink needs it; it is marked, and
// this is the one place that sees through it.

/** Mark stdin as a stand-in terminal, for ink only. Called by index.js. */
export function fakeStdinTTY(stdin = process.stdin) {
  if (!stdin.setRawMode) stdin.setRawMode = () => stdin;
  if (!stdin.ref) stdin.ref = () => stdin;
  if (!stdin.unref) stdin.unref = () => stdin;
  stdin.isTTY = true;
  stdin.flintFakeTTY = true;
}

/** True only for a real terminal: not a pipe, not /dev/null, not the stand-in. */
export function stdinIsRealTTY(stdin = process.stdin) {
  return Boolean(stdin && stdin.isTTY && !stdin.flintFakeTTY);
}

/**
 * What Flint says instead of the first-run wizard when nobody can answer it.
 * One line: what is missing and how to supply it. Null when the wizard can run
 * (or is not needed).
 *
 * @param {{ action?: string }} cli
 * @param {boolean} needsSetup - no key for the active provider
 * @param {boolean} hasTerminal
 * @returns {string|null}
 */
export function noTerminalSetupRefusal(cli, needsSetup, hasTerminal) {
  if (!needsSetup || hasTerminal) return null;
  if (cli?.action === "list" || cli?.action === "stdio" || cli?.action === "check") return null;
  return "[flint] No API key is configured and there is no terminal to ask for one. " +
    "Set a key in the environment (for example OPENROUTER_API_KEY) and a model with --model, " +
    "or run flint in a terminal; for a local model use --provider ollama --model llama3.2.";
}

/** What the console says when its input ended before anything was typed. */
export const NO_INPUT_MESSAGE =
  "[flint] The console needs a terminal and its input closed before anything was typed. " +
  "Run flint in a terminal, or use: flint --headless --task \"...\"";

/**
 * The console with no terminal and an input that ends having given nothing
 * (closed stdin, /dev/null, an empty pipe) can never do anything: it drew
 * "ready" and idled for ever. Say so and stop. An input that did deliver data
 * is left alone, so `printf 'hi\n' | flint` still gets to finish its turn.
 *
 * @param {object} o
 * @param {NodeJS.ReadableStream} [o.stdin]
 * @param {() => void} o.onEmpty - called once, instead of exiting itself
 * @returns {() => void} cancel
 */
export function watchForEmptyInput({ stdin = process.stdin, onEmpty }) {
  let fired = false;
  const check = () => {
    if (fired) return;
    if ((stdin.bytesRead || 0) > 0) return;
    fired = true;
    onEmpty();
  };
  stdin.once("end", check);
  stdin.once("close", check);
  return () => { stdin.off("end", check); stdin.off("close", check); };
}
