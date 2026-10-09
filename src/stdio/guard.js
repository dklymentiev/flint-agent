// First thing index.js imports, so it runs before any other module is
// evaluated. In the stdio mode stdout carries the protocol and nothing else:
// one stray console.log from any module would be a line the host cannot
// parse. So here, before anything can print:
//
//   - the real stdout writer is kept for the protocol (protocolWrite);
//   - process.stdout.write and console.log/info/warn/error go to stderr;
//   - --cwd is applied, so every module sees the agent's own folder;
//   - FLINT_DATA_DIR defaults to ~/.flint, so sessions and the task database
//     live in the home of the user the host runs this agent as (a host that
//     gives every agent its own user and HOME) instead of the checkout.
//
// Outside the stdio mode this module does nothing.

import { format } from "node:util";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseStdioArgs } from "./args.js";

let parsed = null;
let parseError = null;
try {
  parsed = parseStdioArgs(process.argv);
} catch (err) {
  parseError = err;
}

export const stdioArgs = parsed;
export const stdioArgsError = parseError;

const realWrite = process.stdout.write.bind(process.stdout);

/** Write one protocol object as a line on the real stdout. */
export function protocolWrite(obj) {
  realWrite(JSON.stringify(obj) + "\n");
}

if (parsed || parseError) {
  const toStderr = (...args) => { process.stderr.write(format(...args) + "\n"); };
  process.stdout.write = (chunk, encoding, cb) => process.stderr.write(chunk, encoding, cb);
  console.log = toStderr;
  console.info = toStderr;
  console.warn = toStderr;
  console.error = toStderr;
  console.debug = toStderr;
  if (parseError) {
    process.stderr.write(`[flint] ${parseError.message}\n`);
    process.exit(2);
  }
  if (parsed.cwd) {
    try {
      process.chdir(parsed.cwd);
    } catch (err) {
      process.stderr.write(`[flint] cannot use --cwd ${parsed.cwd}: ${err.message}\n`);
      process.exit(2);
    }
  }
  if (!process.env.FLINT_DATA_DIR) {
    if (parsed.dataDir) process.env.FLINT_DATA_DIR = parsed.dataDir;
    else process.env.FLINT_DATA_DIR = join(homedir(), ".flint");
  }
}
