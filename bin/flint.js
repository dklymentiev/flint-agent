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

// `flint --version`: the quickest check that the command works after an
// install, without starting anything.
if (process.argv.includes("--version") || process.argv.includes("-v")) {
  const { readFileSync } = await import("node:fs");
  const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8"));
  console.log(`flint ${pkg.version}`);
  process.exit(0);
}

// The stdio mode runs in this process: no launcher, no splash, no restart.
// A host may pass files as inherited descriptors (--system-prompt-file
// /proc/self/fd/N), and a child process does not get
// them: through bin, launcher and index.js the path named some other
// descriptor of the grandchild, and reading it hung the start (Linux,
// 2026-10-02). One process is also the one the host signals.
const userArgs = process.argv.slice(2);
const stdioMode = userArgs.includes("--stdio") || userArgs.some((a, i) =>
  (a === "--input-format" || a === "--output-format") && userArgs[i + 1] === "stream-json");
if (stdioMode) {
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
}
