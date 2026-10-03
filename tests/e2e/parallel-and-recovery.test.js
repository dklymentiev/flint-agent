// E2E: Parallelism, error handling, memory management
// Uses real tool handlers, store slices, sessions, and checkpoints.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { handlers as fsHandlers, clearDeniedPaths } from "../../src/tools/filesystem.js";
import { createSystemTools } from "../../src/tools/system.js";
import {
  saveCheckpoint, rewind, rewindAll, clearCheckpoints, checkpointCount, getCheckpointStack,
} from "../../src/tools/checkpoint.js";
import { saveSession, loadSession } from "../../src/sessions.js";
import { createStore } from "zustand/vanilla";
import { createUiSlice } from "../../src/store/ui-slice.js";
import { createAgentSlice } from "../../src/store/agent-slice.js";
import { createProcessSlice } from "../../src/store/process-slice.js";
import { createDatasetSlice } from "../../src/store/dataset-slice.js";
import { initOutput } from "../../src/ui/output.js";

// ── Helpers ──────────────────────────────────────────────────

let tmpDir;
let store;
let sysHandlers;

async function makeTmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "flint-e2e-"));
}

function createTestStore() {
  return createStore((...args) => ({
    ...createUiSlice(...args),
    ...createAgentSlice(...args),
    ...createProcessSlice(...args),
    ...createDatasetSlice(...args),
  }));
}

beforeEach(async () => {
  tmpDir = await makeTmpDir();
  clearDeniedPaths();
  clearCheckpoints();
  store = createTestStore();
  initOutput(store);
  const sys = createSystemTools(store);
  sysHandlers = sys.handlers;
});

afterEach(async () => {
  // Best-effort cleanup
  try { await fs.rm(tmpDir, { recursive: true, force: true }); } catch {}
});

// ── 1. 50 parallel file writes ──────────────────────────────

describe("Parallel file operations", () => {
  it("creates 50 files simultaneously via write_file", async () => {
    const promises = Array.from({ length: 50 }, (_, i) =>
      fsHandlers.write_file({
        path: path.join(tmpDir, `file-${i}.txt`),
        content: `content-${i}`,
      }),
    );
    const results = await Promise.all(promises);

    // Every write should succeed
    for (const r of results) {
      expect(r).toContain("File written:");
    }

    // Verify all 50 exist on disk
    const entries = await fs.readdir(tmpDir);
    const txtFiles = entries.filter((f) => f.startsWith("file-") && f.endsWith(".txt"));
    expect(txtFiles.length).toBe(50);
  });

  it("copies and moves files correctly in parallel", async () => {
    // Create source files
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        fsHandlers.write_file({
          path: path.join(tmpDir, `src-${i}.txt`),
          content: `source-${i}`,
        }),
      ),
    );

    // Copy all 10 in parallel
    const copyResults = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        fsHandlers.copy_file({
          source: path.join(tmpDir, `src-${i}.txt`),
          destination: path.join(tmpDir, `copy-${i}.txt`),
        }),
      ),
    );
    for (const r of copyResults) {
      expect(r).toContain("File copied:");
    }

    // Verify copies have correct content
    const content5 = await fs.readFile(path.join(tmpDir, "copy-5.txt"), "utf-8");
    expect(content5).toBe("source-5");

    // Move one file
    const moveResult = await fsHandlers.move_file({
      source: path.join(tmpDir, "copy-0.txt"),
      destination: path.join(tmpDir, "moved-0.txt"),
    });
    expect(moveResult).toContain("File moved:");
    const movedExists = await fs.access(path.join(tmpDir, "moved-0.txt")).then(() => true).catch(() => false);
    const origGone = await fs.access(path.join(tmpDir, "copy-0.txt")).then(() => true).catch(() => false);
    expect(movedExists).toBe(true);
    expect(origGone).toBe(false);
  });

  it("reads 50 files in parallel after creation", async () => {
    // Create files first
    await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        fsHandlers.write_file({
          path: path.join(tmpDir, `read-${i}.txt`),
          content: `data-${i}-payload`,
        }),
      ),
    );

    // Read all 50 in parallel
    const readPromises = Array.from({ length: 50 }, (_, i) =>
      fsHandlers.read_file({ path: path.join(tmpDir, `read-${i}.txt`) }),
    );
    const contents = await Promise.all(readPromises);

    for (let i = 0; i < 50; i++) {
      expect(contents[i]).toContain(`data-${i}-payload`);
    }
  });
});

// ── 2. Process 100 files in parallel batches ─────────────────

describe("Batch parallel search", () => {
  it("searches 100 CSV-like files in batches of 10", async () => {
    // Create 100 files
    const createPromises = Array.from({ length: 100 }, (_, i) =>
      fsHandlers.write_file({
        path: path.join(tmpDir, `data-${String(i).padStart(3, "0")}.csv`),
        content: `id,name,value\n${i},item-${i},${i * 10}\nfoo,bar,baz`,
      }),
    );
    await Promise.all(createPromises);

    // Search in batches of 10
    const batchSize = 10;
    const batchCount = 10;
    const allResults = [];

    for (let b = 0; b < batchCount; b++) {
      const batchPromises = Array.from({ length: batchSize }, (_, j) => {
        const idx = b * batchSize + j;
        return fsHandlers.search_in_files({
          pattern: `item-${idx}`,
          path: tmpDir,
          glob: "*.csv",
          max_results: 5,
        });
      });
      const batchResults = await Promise.all(batchPromises);
      allResults.push(...batchResults);
    }

    // Every search should find at least one match
    for (let i = 0; i < 100; i++) {
      expect(allResults[i]).toContain(`item-${i}`);
    }
  });
});

// ── 3. Background process management ─────────────────────────

describe("Background process management", () => {
  it("starts a process, lists it, kills it, verifies gone", async () => {
    // Start a background command that just sleeps
    const isWin = process.platform === "win32";
    const sleepCmd = isWin ? "ping -n 30 127.0.0.1 >nul" : "sleep 30";
    const startResult = await sysHandlers.run_background_command({
      command: sleepCmd,
      label: "test-sleep",
    });
    expect(startResult).toMatch(/started|Background process/i);

    // Give process a moment to start
    await new Promise((r) => setTimeout(r, 500));

    // list_processes should show it
    const list = await sysHandlers.list_processes();
    expect(list).toContain("test-sleep");
    expect(list).toContain("running");

    // Kill it
    const proc = store.getState().processes.find((p) => p.cmd === "test-sleep");
    expect(proc).toBeDefined();
    const killResult = await sysHandlers.kill_process({ process_id: proc.id });
    expect(killResult).toMatch(/killed|Killed/i);

    // Verify it's gone from running
    await new Promise((r) => setTimeout(r, 300));
    const listAfter = await sysHandlers.list_processes();
    expect(listAfter).not.toMatch(/test-sleep.*running/);
  });
});

// ── 4. Large file handling ──────────────────────────────────

describe("Large file handling", () => {
  it("creates a 10 MB file, reads it, verifies size", async () => {
    const largePath = path.join(tmpDir, "large.txt");

    // Create 10 MB text file (must use .txt to avoid binary detection)
    // Fill with repeating lines of text
    const line = "A".repeat(999) + "\n";
    const chunk = line.repeat(1000); // ~1 MB per chunk
    const chunks = [];
    for (let i = 0; i < 10; i++) chunks.push(chunk);
    await fs.writeFile(largePath, chunks.join(""));

    // Verify file exists and is at least ~10 MB
    const stat = await fs.stat(largePath);
    expect(stat.size).toBeGreaterThanOrEqual(10_000_000);

    // read_file should detect it as large and return a preview/header
    const readResult = await fsHandlers.read_file({ path: largePath });
    expect(readResult).toContain("Large file");
    expect(readResult).toMatch(/\d+(\.\d)? MB/);
  });
});

// ── 5. Rate limiting simulation ─────────────────────────────

describe("Rate limiting simulation", () => {
  it("runs 20 rapid run_command calls without crashing", async () => {
    const promises = Array.from({ length: 20 }, (_, i) =>
      sysHandlers.run_command({ command: `echo rapid-${i}` }),
    );
    const results = await Promise.all(promises);

    // All 20 should complete successfully
    expect(results.length).toBe(20);
    for (let i = 0; i < 20; i++) {
      expect(results[i]).toContain(`rapid-${i}`);
    }
  });

  it("handles mixed success/failure commands rapidly", async () => {
    const cmds = [
      `echo ok-1`,
      `echo ok-2`,
      // Nonexistent command — should return error, not crash
      process.platform === "win32" ? `nonexistent_cmd_xyz 2>&1` : `nonexistent_cmd_xyz 2>&1`,
      `echo ok-3`,
      `echo ok-4`,
    ];
    const results = await Promise.all(cmds.map((c) => sysHandlers.run_command({ command: c })));
    expect(results.length).toBe(5);
    expect(results[0]).toContain("ok-1");
    expect(results[3]).toContain("ok-3");
    // The bad command should return an error string, not throw
    expect(typeof results[2]).toBe("string");
  });
});

// ── 6. Error: read nonexistent file ─────────────────────────

describe("Error handling: read nonexistent file", () => {
  it("returns error string, does not throw", async () => {
    const missingPath = path.join(tmpDir, "does-not-exist.txt");
    const result = await fsHandlers.read_file({ path: missingPath }).catch((e) => `Error: ${e.message}`);
    expect(typeof result).toBe("string");
    expect(result).toMatch(/error|ENOENT|no such file/i);
  });

  it("returns error for nonexistent directory listing", async () => {
    const missingDir = path.join(tmpDir, "ghost-dir");
    const result = await fsHandlers.list_directory({ path: missingDir }).catch((e) => `Error: ${e.message}`);
    expect(typeof result).toBe("string");
    expect(result).toMatch(/error|ENOENT|no such/i);
  });
});

// ── 7. Error: write to readonly/protected path ──────────────

describe("Error handling: a write the OS refuses", () => {
  it("returns the error as a string instead of throwing", async () => {
    // A write that fails for any user, administrator included: the parent
    // "folder" is a file. This used to write into C:\Windows\System32 and
    // count on the OS to refuse, which GitHub's Windows runner, running as
    // administrator, did not (2026-10-02). Refusing system folders is the
    // path guard's job: tests/unit/security/system-paths.test.js.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flint-oserr-"));
    const notADir = path.join(dir, "plain-file");
    await fs.writeFile(notADir, "x");
    const protectedPath = path.join(notADir, "child.txt");

    // The handler wraps errors — should return string, not throw
    let result;
    try {
      result = await fsHandlers.write_file({
        path: protectedPath,
        content: "should fail",
      });
    } catch (err) {
      result = `Error: ${err.message}`;
    }
    expect(typeof result).toBe("string");
    expect(result).toMatch(/error|denied|EPERM|EACCES|ENOTDIR|EEXIST|ENOENT/i);
    await fs.rm(dir, { recursive: true, force: true });
  });
});

// ── 8. Error: kill nonexistent process ──────────────────────

describe("Error handling: kill nonexistent process", () => {
  it("returns error message for PID 999999", async () => {
    const result = await sysHandlers.kill_process({ process_id: 999999 });
    expect(typeof result).toBe("string");
    expect(result).toMatch(/not found|none/i);
  });

  it("returns already-done message when killing a finished process", async () => {
    // Create and immediately finish a process in the store
    const procId = store.getState().addProcess({ cmd: "echo done", pid: 1 });
    store.getState().finishProcess(procId, 0, "done");

    const result = await sysHandlers.kill_process({ process_id: procId });
    expect(result).toMatch(/already done/i);
  });
});

// ── 9. Checkpoint stress ────────────────────────────────────

describe("Checkpoint stress", () => {
  it("writes 20 files with checkpoints, rewinds all 20, verifies restoration", async () => {
    const files = Array.from({ length: 20 }, (_, i) =>
      path.join(tmpDir, `ckpt-${i}.txt`),
    );

    // Write 20 files (each triggers a checkpoint via write_file handler)
    for (const f of files) {
      await fsHandlers.write_file({ path: f, content: "created" });
    }

    // All 20 should exist
    for (const f of files) {
      const stat = await fs.stat(f);
      expect(stat.isFile()).toBe(true);
    }

    // Checkpoint stack should have 20 entries
    expect(checkpointCount()).toBe(20);

    // Rewind all 20 — files were newly created, so rewind should delete them
    const restored = await rewindAll();
    expect(restored.length).toBe(20);

    // Verify all files are gone
    for (const f of files) {
      const exists = await fs.access(f).then(() => true).catch(() => false);
      expect(exists).toBe(false);
    }

    expect(checkpointCount()).toBe(0);
  });

  it("partial rewind restores only last N checkpoints", async () => {
    const files = Array.from({ length: 5 }, (_, i) =>
      path.join(tmpDir, `partial-${i}.txt`),
    );

    for (const f of files) {
      await fsHandlers.write_file({ path: f, content: "data" });
    }
    expect(checkpointCount()).toBe(5);

    // Rewind only 2
    const restored = await rewind(2);
    expect(restored.length).toBe(2);
    expect(checkpointCount()).toBe(3);

    // Last 2 files should be gone, first 3 should remain
    for (let i = 0; i < 3; i++) {
      const exists = await fs.access(files[i]).then(() => true).catch(() => false);
      expect(exists).toBe(true);
    }
    for (let i = 3; i < 5; i++) {
      const exists = await fs.access(files[i]).then(() => true).catch(() => false);
      expect(exists).toBe(false);
    }
  });

  it("getCheckpointStack returns metadata without modifying stack", async () => {
    await fsHandlers.write_file({
      path: path.join(tmpDir, "stack-check.txt"),
      content: "test",
    });

    const stack = getCheckpointStack();
    expect(stack.length).toBe(1);
    expect(stack[0].type).toBe("write");
    expect(stack[0].existed).toBe(false);
    expect(stack[0].timestamp).toBeGreaterThan(0);

    // Stack should not have been modified
    expect(checkpointCount()).toBe(1);
  });

  it("edits existing files, rewinds, verifies original content restored", async () => {
    // Create files first (outside checkpoint tracking)
    const filePath = path.join(tmpDir, "edit-target.txt");
    await fs.writeFile(filePath, "original content", "utf-8");
    clearCheckpoints();

    // Edit via handler (creates checkpoint)
    await fsHandlers.edit_file({
      path: filePath,
      old_text: "original content",
      new_text: "modified content",
    });

    const afterEdit = await fs.readFile(filePath, "utf-8");
    expect(afterEdit).toBe("modified content");

    // Rewind
    const restored = await rewind(1);
    expect(restored.length).toBe(1);
    expect(restored[0].action).toBe("restored");

    const afterRewind = await fs.readFile(filePath, "utf-8");
    expect(afterRewind).toBe("original content");
  });
});

// ── 10. Session data persistence ────────────────────────────

describe("Session data persistence", () => {
  it("rejects tampered session data", async () => {
    const { config } = await import("../../src/config.js");
    const originalDir = config.sessionsDir;
    const sessDir = path.join(tmpDir, "sessions-tamper");
    config.sessionsDir = sessDir;

    try {
      const id = "tamper-test-" + Date.now();
      await saveSession(id, {
        messages: [{ role: "user", content: "hello" }],
        model: "test",
        inputHistory: [],
      });

      // Tamper with the session file
      const filePath = path.join(sessDir, `${id}.json`);
      const raw = await fs.readFile(filePath, "utf-8");
      const data = JSON.parse(raw);
      data.messages[0].content = "TAMPERED";
      await fs.writeFile(filePath, JSON.stringify(data), "utf-8");

      // Load should fail integrity check
      await expect(loadSession(id)).rejects.toThrow(/integrity/i);
    } finally {
      config.sessionsDir = originalDir;
    }
  });

  it("saves and loads a complex session with exact match", async () => {
    // Override sessions dir to use temp
    const { config } = await import("../../src/config.js");
    const originalDir = config.sessionsDir;
    const sessDir = path.join(tmpDir, "sessions");
    config.sessionsDir = sessDir;

    try {
      const sessionId = "test-session-" + Date.now();
      const sessionData = {
        messages: [
          { role: "system", content: "You are a helpful assistant." },
          { role: "user", content: "Explain quantum computing in 3 sentences." },
          { role: "assistant", content: "Quantum computing uses qubits. Superposition allows parallel states. Entanglement enables instant correlation." },
          { role: "user", content: "Now explain it to a 5-year-old." },
        ],
        model: "anthropic/claude-3.5-sonnet",
        inputHistory: ["Explain quantum computing", "Now explain it to a 5-year-old."],
        profile: "generic",
        plan: {
          goal: "Explain quantum computing at different levels",
          steps: [
            { text: "Technical explanation", done: true },
            { text: "Simple explanation", done: false },
          ],
        },
        pastedImages: [{ name: "diagram.png", size: 12345 }],
        lastSummary: "User asked about quantum computing.",
        provider: "anthropic",
      };

      await saveSession(sessionId, sessionData);
      const loaded = await loadSession(sessionId);

      // Verify exact match on key fields
      expect(loaded.id).toBe(sessionId);
      expect(loaded.model).toBe("anthropic/claude-3.5-sonnet");
      expect(loaded.provider).toBe("anthropic");
      expect(loaded.messages).toEqual(sessionData.messages);
      expect(loaded.inputHistory).toEqual(sessionData.inputHistory);
      expect(loaded.profile).toBe("generic");
      expect(loaded.plan).toEqual(sessionData.plan);
      expect(loaded.pastedImages).toEqual(sessionData.pastedImages);
      expect(loaded.lastSummary).toBe("User asked about quantum computing.");
      expect(loaded.updated).toBeDefined();
    } finally {
      config.sessionsDir = originalDir;
    }
  });
});

// ── 11. Memory: store doesn't leak on clear ─────────────────

describe("Memory: store line capacity", () => {
  it("enforces maxDisplayLines cap", () => {
    // config.maxDisplayLines defaults to 1000; add 1005 lines
    for (let i = 0; i < 1005; i++) {
      store.getState().addLine(`line-${i}`);
    }
    // Should be capped at 1000
    expect(store.getState().lines.length).toBeLessThanOrEqual(1000);
    // Last line should be the most recent
    const last = store.getState().lines[store.getState().lines.length - 1];
    expect(last.text).toBe("line-1004");
  });
});

describe("Memory: store clearScreen", () => {
  it("clears 100 lines from store on clearScreen", () => {
    // Add 100 lines
    for (let i = 0; i < 100; i++) {
      store.getState().addLine(`Line ${i}: ${"x".repeat(200)}`);
    }
    expect(store.getState().lines.length).toBe(100);

    // Mock stdout.write to avoid ANSI escape side effects in tests
    const origWrite = process.stdout.write;
    process.stdout.write = () => true;

    try {
      store.getState().clearScreen();
      expect(store.getState().lines.length).toBe(0);
      expect(store.getState().streamText).toBe("");
    } finally {
      process.stdout.write = origWrite;
    }
  });

  it("resets line IDs after clear", () => {
    store.getState().addLine("first");
    store.getState().addLine("second");
    expect(store.getState().nextLineId).toBe(3);

    const origWrite = process.stdout.write;
    process.stdout.write = () => true;

    try {
      store.getState().clearScreen();
      expect(store.getState().nextLineId).toBe(1);
    } finally {
      process.stdout.write = origWrite;
    }
  });
});

// ── 12. Dataset rotation / eviction ─────────────────────────

describe("Dataset rotation", () => {
  it("evicts oldest 2 when adding 12 datasets (max 10)", () => {
    const addDataset = store.getState().addDataset;

    // Add 12 datasets with staggered timestamps
    const ids = [];
    for (let i = 0; i < 12; i++) {
      const id = addDataset({
        label: `dataset-${i}`,
        columns: ["a", "b"],
        rows: [[i, i * 2]],
        source: "test",
      });
      ids.push(id);
    }

    const datasets = store.getState().datasets;
    const keys = Object.keys(datasets);

    // Should have at most 10
    expect(keys.length).toBe(10);

    // The first 2 (oldest) should be evicted
    expect(datasets[ids[0]]).toBeUndefined();
    expect(datasets[ids[1]]).toBeUndefined();

    // The last 10 should survive
    for (let i = 2; i < 12; i++) {
      expect(datasets[ids[i]]).toBeDefined();
      expect(datasets[ids[i]].label).toBe(`dataset-${i}`);
    }
  });

  it("clearDatasets removes all datasets", () => {
    for (let i = 0; i < 5; i++) {
      store.getState().addDataset({
        label: `clear-${i}`,
        columns: ["a"],
        rows: [[i]],
        source: "test",
      });
    }
    expect(Object.keys(store.getState().datasets).length).toBe(5);
    store.getState().clearDatasets();
    expect(Object.keys(store.getState().datasets).length).toBe(0);
  });

  it("preserves dataset content through eviction cycles", () => {
    const { addDataset, getDatasetPage } = store.getState();

    // Fill to capacity
    for (let i = 0; i < 10; i++) {
      addDataset({
        label: `fill-${i}`,
        columns: ["x"],
        rows: Array.from({ length: 5 }, (_, j) => [i * 10 + j]),
        source: "fill",
      });
    }

    // Add one more — should evict oldest
    const newId = store.getState().addDataset({
      label: "new-entry",
      columns: ["x"],
      rows: [[999], [998]],
      source: "test",
    });

    const page = store.getState().getDatasetPage(newId);
    expect(page).not.toBeNull();
    expect(page.label).toBe("new-entry");
    expect(page.rows).toEqual([[999], [998]]);
    expect(page.totalRows).toBe(2);
  });
});
