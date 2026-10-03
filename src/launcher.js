import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const userArgs = process.argv.slice(2);

// --version answers and exits here too, not only in bin/flint.js: a host
// that starts Flint with `npm start -- --version` or `node src/launcher.js
// --version` got a console instead of a version (node integration test,
// 2026-10-02).
if (userArgs.includes("--version") || userArgs.includes("-v")) {
  const { readFileSync } = await import("node:fs");
  console.log(`flint ${JSON.parse(readFileSync(path.join(projectRoot, "package.json"), "utf8")).version}`);
  process.exit(0);
}

const hasSessionArg = userArgs.some(a => a === "--last" || a === "--session" || a === "--list" || a === "--new");

const RESTART_CODE = 42;

// The session a restarting child asked to continue (src/restart.js). A
// restart names its own session, so the operator's --new/--last/--session
// from the first start are left out of the args then.
let resumeSessionId = null;
// /allow-all or /deny-all of the process that asked for the restart, held here
// until the next one is ready and then handed over once (src/restart.js says
// why it travels this way and is never written down).
let carriedBulkPermission = null;
function withoutSessionArgs(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--new" || args[i] === "--last") continue;
    if (args[i] === "--session") { i++; continue; }
    out.push(args[i]);
  }
  return out;
}

// The stdio mode (src/stdio) is driven by a program, not a person: no splash,
// no spinner, and the agent runs in the folder it was started from, which is
// the agent's own folder (its CLAUDE.md, .mcp.json and files).
const stdioMode = userArgs.includes("--stdio") || userArgs.some((a, i) =>
  (a === "--input-format" || a === "--output-format") && userArgs[i + 1] === "stream-json");

// Clear screen + show the FLiNT mark (src/ui/splash.js) with a loading spinner
// on its second row. Raw escapes, no chalk: the launcher loads nothing it can
// avoid. Titanium is 256-colour 250, the spark yellow 220, grey 244.
const _mark0 = " \x1b[38;5;250m▀▀▀ █   \x1b[38;5;220m▀\x1b[38;5;250m █▄ █ ▀█▀\x1b[0m";
const _mark1 = " \x1b[38;5;250m█▀▀ █▄▄ █ █ ▀█  █\x1b[0m";
const _frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
if (!stdioMode) process.stderr.write(`\x1b[2J\x1b[H\n${_mark0}\n${_mark1}   \x1b[38;5;244m${_frames[0]} loading...\x1b[0m`);
let _fi = 0;
let _released = false;
const _spinner = setInterval(() => {
  _fi = (_fi + 1) % _frames.length;
  if (_released) return;
  process.stderr.write(`\r${_mark1}   \x1b[38;5;244m${_frames[_fi]} loading...\x1b[0m`);
}, 120);

/**
 * Hand the terminal over to the child.
 *
 * The spinner repaints with a bare `\r`, which the terminal reads as "back to
 * column 0 of whatever line is current now". Once the child starts drawing,
 * that is no longer the spinner's line: every tick reprints the FLINT AGENT
 * banner on top of the child's own banner, and the startup banner with the
 * first commands underneath it appears several times over.
 *
 * This used to be a fixed 500 ms after spawn, on the assumption that the child
 * would be rendering by then. How long that takes depends on module load and on
 * the machine, so a slow start got the spinner writing into a live UI, which is
 * the reported glitch.
 *
 * The child is spawned with `stdio: "inherit"`, so it has no pipe handles to
 * listen to: child.stdout and child.stderr are both null. An earlier attempt
 * attached "release on first output" to those and did nothing at all, which
 * would have left the spinner running forever while appearing to work. The
 * streams stay inherited on purpose — piping them would cost Ink the TTY, and
 * raw-mode key handling with it.
 *
 * So the child says when it is about to draw, over an IPC channel that costs
 * nothing and is invisible to the terminal, and waits for "flint:released"
 * before it clears the screen. The interval is kept as a ceiling rather
 * than removed: a child that dies without saying anything must not hold the
 * event loop open, and `_released` makes the remaining ticks no-ops.
 */
function releaseTerminal() {
  _released = true;
  clearInterval(_spinner);
}

function start(extraArgs = []) {
  const defaultArgs = (!hasSessionArg && extraArgs.length === 0 && !stdioMode) ? ["--new"] : [];
  const baseArgs = extraArgs.length ? withoutSessionArgs(userArgs) : userArgs;
  const args = [path.join(projectRoot, "src", "index.js"), ...baseArgs, ...defaultArgs, ...extraArgs];
  const child = spawn(process.execPath, args, {
    // The three standard streams stay inherited: piping them would cost Ink the
    // TTY, and with it raw-mode key handling. The fourth slot is an IPC
    // channel, which does not touch the terminal, and is how the child says
    // "I have drawn" so the spinner stops repainting over it.
    stdio: ["inherit", "inherit", "inherit", "ipc"],
    cwd: stdioMode ? process.cwd() : projectRoot,
  });
  if (stdioMode) releaseTerminal();

  // On "flint:ready": stop first, answer after. Once the child has the answer
  // no tick can follow, so it can clear the screen safely (src/index.js).
  child.on("message", (msg) => {
    if (msg && msg.type === "flint:ready") {
      releaseTerminal();
      const bulkPermission = carriedBulkPermission;
      carriedBulkPermission = null;
      try { child.send({ type: "flint:released", ...(bulkPermission ? { bulkPermission } : {}) }); } catch {}
    }
    if (msg && msg.type === "flint:restart" && typeof msg.sessionId === "string") {
      resumeSessionId = msg.sessionId;
      carriedBulkPermission = msg.bulkPermission === "allow" || msg.bulkPermission === "deny" ? msg.bulkPermission : null;
    }
  });

  // `exit` always arrives, and it must stop the interval even if the child
  // never said anything — otherwise it holds the event loop open.
  child.on("exit", (code) => {
    releaseTerminal();
    if (code === RESTART_CODE && !stdioMode) {
      // The same session when the child said which; a new one otherwise.
      const id = resumeSessionId;
      resumeSessionId = null;
      start(id ? ["--session", id] : ["--new"]);
    } else {
      process.exit(code ?? 0);
    }
  });
  child.on("error", releaseTerminal);

  // Forward Ctrl+C to child gracefully
  process.on("SIGINT", () => {
    child.kill("SIGINT");
  });
}

start();
