// Every integration test file runs with its own empty cwd.
//
// The agent loop reads what a turn changed off its folders, cwd first.
// Left at the repo, cwd is shared by test files running in parallel, and files
// one of them writes count as another's turn: an extra verify step, an extra
// outcome question, a call count off by one, depending on timing.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "flint-it-"));
const home = process.cwd();
process.chdir(dir);
process.on("exit", () => {
  try { process.chdir(home); rmSync(dir, { recursive: true, force: true }); } catch {}
});
