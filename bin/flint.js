#!/usr/bin/env node

// Flint CLI entry point
// Delegates to launcher.js (which handles auto-restart on exit code 42).
// Plain Node, no loader: the source has no JSX (components call
// createElement). The esbuild loader this used to start with was a dev
// dependency, so `npm install -g` left `flint` unable to start.

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const launcher = join(__dirname, "..", "src", "launcher.js");

// A host must be able to reject older stdio builds before giving them a
// provider key: they imported API keys from the environment into keys.enc.
// This check starts no agent and reads no credential.
if (process.argv.includes("--sn-stdio-ephemeral-key-check")) {
  console.log("flint-stdio-ephemeral-key-v1");
  process.exit(0);
}

// `flint --version`: the quickest check that the command works after an
// install, without starting anything.
if (process.argv.includes("--version") || process.argv.includes("-v")) {
  const { readFileSync } = await import("node:fs");
  const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8"));
  console.log(`flint ${pkg.version}`);
  process.exit(0);
}

// `flint --help`: the usage text, before any child is started.
{
  const { HELP_TEXT, wantsHelp } = await import("../src/help.js");
  if (wantsHelp(process.argv)) {
    process.stdout.write(HELP_TEXT);
    process.exit(0);
  }
}

// The stdio and check modes run in this process: no launcher, no splash, no
// restart. --check is a minimal probe that must be quick and one-process
// (the launcher's splash/IPC handshake adds seconds that the probe exists to
// avoid). A host may pass files as inherited descriptors (--system-prompt-file
// /proc/self/fd/N), and a child process does not get them: through bin,
// launcher and index.js the path named some other descriptor of the grandchild,
// and reading it hung the start (Linux, 2026-10-02).
const userArgs = process.argv.slice(2);
const stdioMode = userArgs.includes("--stdio") || userArgs.some((a, i) =>
  (a === "--input-format" || a === "--output-format") && userArgs[i + 1] === "stream-json");
const checkMode = userArgs.includes("--check");
if (stdioMode || checkMode) {
  await import(new URL("../src/index.js", import.meta.url));
} else {

const child = spawn(process.execPath, [
  launcher,
  ...userArgs,
], {
  stdio: "inherit",
  cwd: process.cwd(),
});

child.on("exit", (code) => process.exit(code ?? 1));

// Forward SIGTERM to the launcher child. Without this, a headless Flint
// started via `bin/flint.js` receives SIGTERM (e.g. from a CI timeout) but
// dies immediately — the real handler is two levels deeper in
// src/index.js (bin/flint.js → launcher.js → index.js). The launcher
// forwards it further; here we just relay it and let child.on("exit")
// keep this process alive until the whole chain finishes.
process.on("SIGTERM", () => child.kill("SIGTERM"));
}
