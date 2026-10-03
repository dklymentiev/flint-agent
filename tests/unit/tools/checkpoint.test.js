import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  saveCheckpoint,
  rewind,
  rewindAll,
  getCheckpointStack,
  clearCheckpoints,
  checkpointCount,
  checkpointRetainedBytes,
  MAX_DEPTH,
} from "../../../src/tools/checkpoint.js";
import { createTmpDir } from "../../helpers/tmp-dir.js";
import fs from "node:fs";
import path from "node:path";

let tmp;

beforeEach(() => {
  tmp = createTmpDir();
  clearCheckpoints();
});

afterEach(() => {
  clearCheckpoints();
  tmp.cleanup();
});

// ── saveCheckpoint ──

describe("saveCheckpoint", () => {
  it("saves file content before modification", async () => {
    const filePath = path.join(tmp.path, "original.txt");
    fs.writeFileSync(filePath, "original content", "utf-8");

    await saveCheckpoint(filePath, "modify");

    const stack = getCheckpointStack();
    expect(stack).toHaveLength(1);
    expect(stack[0].path).toBe(path.resolve(filePath));
    expect(stack[0].existed).toBe(true);
    expect(stack[0].type).toBe("modify");
    expect(stack[0].timestamp).toBeGreaterThan(0);
  });

  it("creates checkpoint entry in stack", async () => {
    const filePath = path.join(tmp.path, "a.txt");
    fs.writeFileSync(filePath, "aaa", "utf-8");

    await saveCheckpoint(filePath, "write");
    expect(checkpointCount()).toBe(1);

    await saveCheckpoint(filePath, "edit");
    expect(checkpointCount()).toBe(2);
  });

  it("handles nonexistent file (new file checkpoint)", async () => {
    const filePath = path.join(tmp.path, "not-yet.txt");

    await saveCheckpoint(filePath, "write");

    const stack = getCheckpointStack();
    expect(stack).toHaveLength(1);
    expect(stack[0].existed).toBe(false);
  });

  it("resolves relative paths to absolute", async () => {
    const filePath = path.join(tmp.path, "rel.txt");
    fs.writeFileSync(filePath, "data", "utf-8");

    await saveCheckpoint(filePath);

    const stack = getCheckpointStack();
    expect(path.isAbsolute(stack[0].path)).toBe(true);
  });
});

// ── rewind ──

describe("rewind", () => {
  it("rewind 1 change restores original content", async () => {
    const filePath = path.join(tmp.path, "rewind1.txt");
    fs.writeFileSync(filePath, "before", "utf-8");

    await saveCheckpoint(filePath);
    // Simulate modification
    fs.writeFileSync(filePath, "after", "utf-8");

    const restored = await rewind(1);
    expect(restored).toHaveLength(1);
    expect(restored[0].action).toBe("restored");
    expect(fs.readFileSync(filePath, "utf-8")).toBe("before");
  });

  it("rewind N changes restores N files", async () => {
    const file1 = path.join(tmp.path, "f1.txt");
    const file2 = path.join(tmp.path, "f2.txt");
    fs.writeFileSync(file1, "orig1", "utf-8");
    fs.writeFileSync(file2, "orig2", "utf-8");

    await saveCheckpoint(file1);
    fs.writeFileSync(file1, "changed1", "utf-8");

    await saveCheckpoint(file2);
    fs.writeFileSync(file2, "changed2", "utf-8");

    const restored = await rewind(2);
    expect(restored).toHaveLength(2);
    expect(fs.readFileSync(file1, "utf-8")).toBe("orig1");
    expect(fs.readFileSync(file2, "utf-8")).toBe("orig2");
  });

  it("rewind on empty stack returns empty array", async () => {
    const restored = await rewind(1);
    expect(restored).toEqual([]);
  });

  it("restoring deletes files that were newly created", async () => {
    const filePath = path.join(tmp.path, "newfile.txt");
    // Checkpoint before file exists
    await saveCheckpoint(filePath, "write");
    // Simulate creating the file
    fs.writeFileSync(filePath, "new content", "utf-8");
    expect(fs.existsSync(filePath)).toBe(true);

    const restored = await rewind(1);
    expect(restored).toHaveLength(1);
    expect(restored[0].action).toBe("deleted (was new)");
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it("rewind reduces stack count", async () => {
    const filePath = path.join(tmp.path, "count.txt");
    fs.writeFileSync(filePath, "data", "utf-8");

    await saveCheckpoint(filePath);
    await saveCheckpoint(filePath);
    await saveCheckpoint(filePath);
    expect(checkpointCount()).toBe(3);

    await rewind(2);
    expect(checkpointCount()).toBe(1);
  });

  it("rewind more than stack size only pops available", async () => {
    const filePath = path.join(tmp.path, "few.txt");
    fs.writeFileSync(filePath, "data", "utf-8");

    await saveCheckpoint(filePath);
    const restored = await rewind(100);
    expect(restored).toHaveLength(1);
    expect(checkpointCount()).toBe(0);
  });
});

// ── rewindAll ──

describe("rewindAll", () => {
  it("reverts all changes in stack", async () => {
    const file1 = path.join(tmp.path, "all1.txt");
    const file2 = path.join(tmp.path, "all2.txt");
    const file3 = path.join(tmp.path, "all3.txt");

    fs.writeFileSync(file1, "a", "utf-8");
    fs.writeFileSync(file2, "b", "utf-8");

    await saveCheckpoint(file1);
    fs.writeFileSync(file1, "x", "utf-8");

    await saveCheckpoint(file2);
    fs.writeFileSync(file2, "y", "utf-8");

    await saveCheckpoint(file3, "write"); // new file
    fs.writeFileSync(file3, "z", "utf-8");

    const restored = await rewindAll();
    expect(restored).toHaveLength(3);
    expect(fs.readFileSync(file1, "utf-8")).toBe("a");
    expect(fs.readFileSync(file2, "utf-8")).toBe("b");
    expect(fs.existsSync(file3)).toBe(false);
    expect(checkpointCount()).toBe(0);
  });
});

// ── checkpointCount ──

describe("checkpointCount", () => {
  it("returns 0 when empty", () => {
    expect(checkpointCount()).toBe(0);
  });

  it("returns correct count after saves", async () => {
    const filePath = path.join(tmp.path, "cnt.txt");
    fs.writeFileSync(filePath, "data", "utf-8");

    await saveCheckpoint(filePath);
    expect(checkpointCount()).toBe(1);

    await saveCheckpoint(filePath);
    expect(checkpointCount()).toBe(2);
  });
});

// ── clearCheckpoints ──

describe("clearCheckpoints", () => {
  it("empties the stack", async () => {
    const filePath = path.join(tmp.path, "clear.txt");
    fs.writeFileSync(filePath, "data", "utf-8");

    await saveCheckpoint(filePath);
    await saveCheckpoint(filePath);
    expect(checkpointCount()).toBe(2);

    clearCheckpoints();
    expect(checkpointCount()).toBe(0);
    expect(getCheckpointStack()).toEqual([]);
  });
});

// ── getCheckpointStack ──

describe("getCheckpointStack", () => {
  it("returns the stack contents with correct shape", async () => {
    const filePath = path.join(tmp.path, "stack.txt");
    fs.writeFileSync(filePath, "hello", "utf-8");

    await saveCheckpoint(filePath, "edit");

    const stack = getCheckpointStack();
    expect(stack).toHaveLength(1);
    expect(stack[0]).toHaveProperty("path");
    expect(stack[0]).toHaveProperty("type", "edit");
    expect(stack[0]).toHaveProperty("existed", true);
    expect(stack[0]).toHaveProperty("timestamp");
  });

  it("returns empty array when no checkpoints", () => {
    expect(getCheckpointStack()).toEqual([]);
  });

  it("does not expose file content (security)", async () => {
    const filePath = path.join(tmp.path, "secret.txt");
    fs.writeFileSync(filePath, "secret-data", "utf-8");

    await saveCheckpoint(filePath);
    const stack = getCheckpointStack();
    // getCheckpointStack maps out content — should not have it
    expect(stack[0]).not.toHaveProperty("content");
  });
});

// ── the process grows without bound ──
//
// The owner's numbers, 2026-09-29/30: one process climbed 2.43 GB at 06:39 →
// 3.33 GB at 07:26, and another died that night at ~4 GB with
// "FATAL ERROR: Reached heap limit ... JavaScript heap out of memory".
//
// The detail that identifies the retainer: /new at 07:08, with nothing in
// flight, took it only to 3.05 GB. If the session's message history were what
// grew, /new would have released it and the number would have dropped with it.
// It did not, so the growth is in state that outlives a session. This is that
// state: saveCheckpoint is called before every write_file, edit_file and
// delete_file, each entry keeps the file's full content, and nothing pops the
// stack in normal use — only /rewind does, and the owner was not rewinding.
// /new does not clear it either, which is precisely why the memory survived
// the one operation that should have dropped it.
//
// These are measurements, not vibes: each test prints what the stack was
// actually holding, so a regression reports how many bytes it kept.
describe("the checkpoint stack does not grow without bound", () => {
  it("does not retain a copy of every file for the life of the process", async () => {
    // 400 edits of a 200 KB file: 80 MB if nothing is released. This is a
    // small version of the owner's day, chosen so the failure is a number
    // rather than a judgement call.
    const FILE_BYTES = 200 * 1024;
    const EDITS = 400;
    const filePath = path.join(tmp.path, "big.txt");
    const body = "x".repeat(FILE_BYTES);
    fs.writeFileSync(filePath, body, "utf-8");

    for (let i = 0; i < EDITS; i++) {
      await saveCheckpoint(filePath, "edit");
    }

    const bytes = checkpointRetainedBytes();
    const count = checkpointCount();
    // eslint-disable-next-line no-console
    console.log(
      `[item 12] after ${EDITS} edits of a ${FILE_BYTES}-byte file: ` +
      `${count} checkpoints, ${bytes} bytes retained ` +
      `(unbounded would be ~${((EDITS * FILE_BYTES) / 1024 / 1024).toFixed(1)} MB)`,
    );

    expect(
      bytes,
      `the stack retained ${bytes} bytes after ${EDITS} edits — unbounded`,
    ).toBeLessThanOrEqual(MAX_DEPTH * FILE_BYTES);
    expect(count).toBeLessThanOrEqual(MAX_DEPTH);
  });

  it("keeps rewind working for the depth it advertises", async () => {
    // The bound must not break the feature. If the oldest entries fall off, the
    // recent ones must still rewind correctly — that is the whole point of the
    // stack, and a fix that emptied it would pass a size test while deleting
    // /rewind.
    const filePath = path.join(tmp.path, "recent.txt");
    for (let i = 0; i < MAX_DEPTH + 20; i++) {
      fs.writeFileSync(filePath, `v${i}`, "utf-8");
      await saveCheckpoint(filePath, "edit");
    }
    // The most recent change is on top and is restorable.
    fs.writeFileSync(filePath, "current", "utf-8");
    const restored = await rewind(1);
    expect(restored).toHaveLength(1);
    expect(fs.readFileSync(filePath, "utf-8")).toBe(`v${MAX_DEPTH + 19}`);
  });

  it("frees the memory the entries held", async () => {
    // The measurement from the other end: after trimming, the retained bytes
    // must be far below what was pushed in. Guards a trim that only counts
    // entries and never drops content.
    const filePath = path.join(tmp.path, "measure.txt");
    fs.writeFileSync(filePath, "y".repeat(100_000), "utf-8");
    for (let i = 0; i < 300; i++) {
      await saveCheckpoint(filePath, "edit");
    }
    const bytes = checkpointRetainedBytes();
    // eslint-disable-next-line no-console
    console.log(`[item 12] retained ${bytes} bytes for 300 edits of 100 KB`);
    expect(bytes).toBeLessThan(300 * 100_000 / 2);
  });
});
