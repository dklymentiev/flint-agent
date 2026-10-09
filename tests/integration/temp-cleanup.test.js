// Integration test: temp files Flint creates during a run are tracked and
// cleaned up at process exit, including when the process is killed by SIGTERM
// (which simulates the step-budget ceiling or user abort).
//
// Strategy:
//   1. Record the set of flint temp file patterns in os.tmpdir() BEFORE.
//   2. Spawn a real Node child process that imports Flint's temp tracker,
//      creates temp files/dirs through it, then waits silently for a signal.
//   3. Send a REAL SIGTERM via child.kill("SIGTERM") and assert:
//     (a) the process exits within a reasonable time,
//     (b) no NEW flint temp files remain in os.tmpdir(),
//     (c) the exit code reflects the signal (128 + signal number).
//
// RED on the old (broken) code: the old SIGTERM handler cleaned up files but
// did NOT re-emit the signal or ensure termination, so the child process hangs
// forever after the signal — the test times out and fails.
// GREEN on the fixed code: the handler removes itself and re-sends the signal,
// so the process terminates with code 128+15=143 and leaves no temp files.
import { describe, it, expect, afterAll } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const tmpRoot = os.tmpdir();

// Patterns of temp files/dirs Flint creates during a run
const PATTERNS = ["flint-check-", "flint-check-data-", "flint-agent-", "flint_clipboard_"];

afterAll(() => {
  try {
    for (const f of fs.readdirSync(tmpRoot)) {
      if (f.startsWith("flint-temp-test-")) {
        try { fs.unlinkSync(path.join(tmpRoot, f)); } catch {}
      }
    }
  } catch {}
});

/** Snapshot the flint temp files currently in the system temp dir. */
function snapshotFlintTempFiles() {
  const set = new Set();
  try {
    for (const f of fs.readdirSync(tmpRoot)) {
      if (PATTERNS.some((p) => f.startsWith(p))) set.add(f);
    }
  } catch {}
  return set;
}

/** Find NEW flint temp files that appeared between two snapshots. */
function findNewFlintTempFiles(before) {
  const after = snapshotFlintTempFiles();
  const newFiles = [];
  for (const f of after) {
    if (!before.has(f)) newFiles.push(f);
  }
  return newFiles;
}

/** Import URL for the temp-tracker module */
const tempTrackerUrl = pathToFileURL(path.join(repoRoot, "src/temp-tracker.js")).href;

// Child script: imports the tracker, creates temp files/dirs through it,
// registers them for cleanup, then waits indefinitely for a signal.
// The parent sends SIGTERM externally via child.kill("SIGTERM").
function makeChildCode() {
  return `
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
const { trackTempFile, trackTempDir } = await import(${JSON.stringify(tempTrackerUrl)});
const dir = mkdtempSync(join(tmpdir(), "flint-check-" + randomUUID().slice(0,8)));
writeFileSync(join(dir, "data.txt"), "test");
trackTempDir(dir);
const dataDir = mkdtempSync(join(tmpdir(), "flint-check-data-" + randomUUID().slice(0,8)));
trackTempDir(dataDir);
const tmpFile = join(tmpdir(), "flint_clipboard_" + Date.now() + ".txt");
writeFileSync(tmpFile, "clipboard");
trackTempFile(tmpFile);
// Report tracked paths to the parent, then wait for a signal.
process.stdout.write(JSON.stringify({ ready: true, dir, dataDir, tmpFile }) + "\\n");
// Keep the event loop alive until SIGTERM arrives — without a timer or
// interval the child exits immediately after writing stdout, the exit
// handler cleans up files, and the parent's existence check races a
// process that is already gone.
setInterval(() => {}, 1000);
`;
}

/** Spawn a child that tracks temp files and waits for SIGTERM. */
async function spawnChildAndSendSignal(signalName) {
  const scriptPath = path.join(tmpRoot, "flint-temp-test-" + randomUUID() + ".mjs");
  await fs.promises.writeFile(scriptPath, makeChildCode());

  try {
    const child = spawn(process.execPath, [scriptPath], {
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Read the JSON line with tracked paths so the parent knows they exist.
    let timer;
    const trackedPaths = await new Promise((resolve, reject) => {
      let buf = "";
      timer = setTimeout(() => {
        reject(new Error("timed out waiting for child readiness marker"));
      }, 10000);
      child.stdout.on("data", (chunk) => {
        buf += chunk;
        const nl = buf.indexOf("\n");
        if (nl !== -1) {
          clearTimeout(timer);
          try {
            resolve(JSON.parse(buf.slice(0, nl).trim()));
          } catch (e) {
            reject(new Error("could not parse child readiness JSON: " + e.message));
          }
        }
      });
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });

    // Assert readiness marker is present.
    expect(trackedPaths.ready, "child did not emit readiness marker").toBe(true);

    // Assert tracked files exist before the signal.
    expect(fs.existsSync(trackedPaths.dir), "tracked dir should exist before signal").toBe(true);
    expect(fs.existsSync(trackedPaths.tmpFile), "tracked file should exist before signal").toBe(true);

    // Send the real signal.
    const sigNum = { SIGKILL: 9, SIGTERM: 15, SIGINT: 2 }[signalName];
    child.kill(signalName);

    // Wait for the child to exit, with a timeout.
    const code = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (!child.killed) {
          child.kill("SIGKILL");
        }
        resolve(null);
      }, 5000);
      child.on("exit", (exitCode, signal) => {
        clearTimeout(timer);
        // On signal death, exitCode is null and signal is the signal name.
        // We report the convention code (128 + signum) for assertion.
        resolve(signal ? 128 + sigNum : exitCode);
      });
    });

    // Clean up the wrapper script.
    try { fs.unlinkSync(scriptPath); } catch {}

    return { code, trackedPaths };
  } finally {
    try { fs.unlinkSync(scriptPath); } catch {}
  }
}

describe("temp-tracker module: direct API", () => {
  it("registers and cleans up tracked temp files on cleanupTempFiles()", async () => {
    const { trackTempFile, trackTempDir, cleanupTempFiles } =
      await import(tempTrackerUrl);

    const before = snapshotFlintTempFiles();

    const dir = fs.mkdtempSync(path.join(tmpRoot, "flint-check-test-"));
    const file = path.join(tmpRoot, "flint_clipboard_test.txt");
    fs.writeFileSync(path.join(dir, "inner.txt"), "hello");
    fs.writeFileSync(file, "clip");

    trackTempDir(dir);
    trackTempFile(file);

    expect(fs.existsSync(dir)).toBe(true);
    expect(fs.existsSync(file)).toBe(true);

    cleanupTempFiles();

    expect(fs.existsSync(dir), "tracked dir was not cleaned up").toBe(false);
    expect(fs.existsSync(file), "tracked file was not cleaned up").toBe(false);

    const newFiles = findNewFlintTempFiles(before);
    expect(newFiles, `temp files left after cleanup: ${newFiles.join(", ")}`).toHaveLength(0);
  });
});

describe("temp file cleanup on process exit", () => {
  it("cleans up tracked temp files on normal process exit", async () => {
    const before = snapshotFlintTempFiles();

    // For normal exit, we spawn a variant that exits on its own.
    const scriptPath = path.join(tmpRoot, "flint-temp-test-" + randomUUID() + ".mjs");
    const childCode = makeChildCode() + '\nsetTimeout(() => process.exit(0), 300);';
    await fs.promises.writeFile(scriptPath, childCode);

    try {
      const child = spawn(process.execPath, [scriptPath], {
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
      });

      const code = await new Promise((resolve) => {
        child.on("exit", resolve);
      });

      const newFiles = findNewFlintTempFiles(before);
      expect(newFiles, `temp files left after normal exit: ${newFiles.join(", ")}`).toHaveLength(0);
      expect(code).toBe(0);
    } finally {
      try { fs.unlinkSync(scriptPath); } catch {}
    }
  }, 15000);

  // On Windows, child.kill("SIGTERM") terminates the process forcefully (no
  // signal handler gets a chance to run), so a faithful check of the SIGTERM
  // handler is impossible there. This test is Linux/macOS only.
  it.skipIf(process.platform === "win32")(
    "cleans up tracked temp files when the process receives SIGTERM",
    async () => {
      const before = snapshotFlintTempFiles();
      const { code, trackedPaths } = await spawnChildAndSendSignal("SIGTERM");

      // (b) process must have exited (not hung — exit code is not null)
      expect(code, "process did not exit after SIGTERM (handler failed to terminate)").not.toBeNull();

      // (c) exit code must reflect the signal: 128 + 15 = 143
      expect(code, `expected exit code 143 (128+SIGTERM), got ${code}`).toBe(128 + 15);

      // (b) temp files must be cleaned up
      expect(fs.existsSync(trackedPaths.dir), "tracked dir was not cleaned up on SIGTERM").toBe(false);
      expect(fs.existsSync(trackedPaths.tmpFile), "tracked file was not cleaned up on SIGTERM").toBe(false);

      const newFiles = findNewFlintTempFiles(before);
      expect(newFiles, `temp files left after SIGTERM: ${newFiles.join(", ")}`).toHaveLength(0);
    },
    15000,
  );
});
