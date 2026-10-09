// Imported by src/index.js before every module that does work at load time
// (config.js reads the key store, for one). ES module imports evaluate in
// order, so answering --help here means it never waits on any of them.
// The --version answer in index.js and launcher.js is the older sibling of this.
import { writeSync } from "node:fs";
import { HELP_TEXT, wantsHelp } from "./help.js";

if (wantsHelp(process.argv)) {
  // Synchronous on purpose: the next module in the import list must not start
  // loading while a callback-based write is still pending.
  try { writeSync(1, HELP_TEXT); } catch { process.stdout.write(HELP_TEXT); }
  process.exit(0);
}
