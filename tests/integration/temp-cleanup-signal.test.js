// Integration test for the temp-tracker signal defect.
//
// Defect: src/temp-tracker.js installs SIGTERM/SIGINT listeners that clean
// up tracked temp files but never terminate the process. On Linux/macOS, a
// Node process that installs a signal listener LOSES the default behaviour of
// dying on that signal. So any Flint run that tracked even one temp file
// would survive SIGTERM and Ctrl+C forever.
//
// This test spawns a REAL child process and sends it a genuine SIGTERM via
// child.kill("SIGTERM"). It asserts:
//   1. the child actually EXITS (does not linger),
//   2. the child exits with the conventional 128+signum code (143 for SIGTERM),
//   3. the tracked temp dir was removed (cleaned by the handler before exit).
//
// Windows caveat: on Windows child.kill("SIGTERM") is an OS-level hard
// terminate (TerminateProcess) and never delivers the signal into the Node JS
// handler, so the handler-driven exit path is NOT exercisable here. The defect
// is Linux/macOS-only and the meaningful verification MUST happen on Linux
// (run by the operator in a container). On Windows this whole describe is
// skipped so the suite stays green here and doesn't make spurious assertions
// about behaviour the OS makes impossible to observe.
//
// RED on Linux with the current (buggy) code: the handler runs, cleans up,
// but the process never exits -> the 5s exit-wait times out -> test fails.
// GREEN after the fix: the handler cleans up and then terminates the process
// with code 128+signum, so the child exits within the timeout and the temp
// dir is gone.
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const tmpRoot = os.tmpdir();
const isWin = os.platform() === "win32";

const tempTrackerUrl = pathToFileURL(path.join(repoRoot, "src/temp-tracker.js")).href;

// Child program: import the tracker, create+track a temp dir, then block
// forever. The ONLY thing that should end the process is the tracker's
// signal handler -- there is no process.exit() call of its own.
const CHILD_SRC = `
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
const tracker = await import(${JSON.stringify(tempTrackerUrl)});
const { trackTempDir } = tracker;
const dir = mkdtempSync(join(tmpdir(), "flint-check-sig-" + randomUUID().slice(0, 8)));
writeFileSync(join(dir, "ping.txt"), "alive");
trackTempDir(dir);
process.stdout.write(JSON.stringify({ dir }) + "\\n");
setInterval(() => {}, 1000);
`;

let childScriptPath;
afterAll(() => {
  try { fs.unlinkSync(childScriptPath); } catch {}
});

const run = describe;
const maybeSkip = isWin ? describe.skip : describe;

maybeSkip("temp-tracker must terminate the process on SIGTERM", () => {
  let childScriptReady = false;
  beforeAll(async () => {
    childScriptPath = path.join(tmpRoot, "flint-temp-sig-test-" + randomUUID() + ".mjs");
    await fs.promises.writeFile(childScriptPath, CHILD_SRC);
    childScriptReady = true;
  });

  it("process exits after SIGTERM and tracked temp dir is removed", async () => {
    expect(childScriptReady, "child script was not prepared").toBe(true);
    const child = spawn(process.execPath, [childScriptPath], {
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    child.stdout.on("data", (d) => { stdout += d.toString(); });

    // Wait for the child to print the dir it is guarding.
    await new Promise((resolve) => {
      const tick = () => {
        if (stdout.includes('"dir"')) resolve();
      };
      child.stdout.on("data", tick);
      setTimeout(resolve, 3000);
    });

    const parsed = JSON.parse(stdout.split("\n").find((l) => l.includes('"dir"')) || "{}");
    const dirPath = parsed.dir;
    expect(dirPath, "child did not report its temp dir").toBeTruthy();
    expect(fs.existsSync(dirPath), "temp dir must exist while child runs").toBe(true);

    const waitExit = new Promise((resolve) => {
      child.on("exit", (code, sig) => resolve({ code, sig }));
    });

    // Send a real SIGTERM to the child's PID.
    child.kill("SIGTERM");

    const result = await Promise.race([
      waitExit,
      // 5s is plenty for a handler that cleans up and exits; the buggy code
      // on Linux never exits, so this times out -> RED.
      new Promise((resolve) => setTimeout(() => resolve(null), 5000)),
    ]);

    if (!result) {
      // Process did not exit within the window -> the defect is present.
      try { child.kill("SIGKILL"); } catch {}
      expect.fail("process did NOT exit after SIGTERM (defect: signal handler cleans up but never terminates the process)");
    }

    // Linux/macOS: the child must exit with the conventional 128+signum code.
    const exitCode = result.code !== null ? result.code
      : (result.sig ? 128 + (result.sig === "SIGTERM" ? 15 : 0) : null);
    expect(exitCode, "child must exit with 128+signum after SIGTERM (got " + JSON.stringify(result) + ")").toBe(143);
    expect(fs.existsSync(dirPath), "tracked temp dir must be removed on signal").toBe(false);
  }, 15000);
});
