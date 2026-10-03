// An instance must be able to keep its own data.
//
// On 2026-09-21 the readiness subject and the operator's live agent shared
// sessions/ and ~/.flint/memory/index.sqlite. The measured run carried thirteen
// turns of somebody else's traffic before its first probe, both processes wrote
// facts into one database, and the unit test that clears the facts table in
// beforeEach was racing a live agent writing to it.
//
// FLINT_DATA_DIR moves everything an instance writes. The checks import the
// modules fresh under a changed environment, because both read it once at load.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "node:path";

const ORIGINAL = process.env.FLINT_DATA_DIR;

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.FLINT_DATA_DIR;
  else process.env.FLINT_DATA_DIR = ORIGINAL;
  vi.resetModules();
});

describe("FLINT_DATA_DIR", () => {
  it("moves the sessions directory", async () => {
    process.env.FLINT_DATA_DIR = path.join(process.cwd(), "tmp-bench-home");
    const { config } = await import("../../src/config.js");
    expect(config.sessionsDir).toBe(path.join(process.cwd(), "tmp-bench-home", "sessions"));
  });

  it("moves the memory database", async () => {
    process.env.FLINT_DATA_DIR = path.join(process.cwd(), "tmp-bench-home");
    const { memoryDbPath } = await import("../../src/memory/sqlite-store.js");
    expect(memoryDbPath()).toBe(path.join(process.cwd(), "tmp-bench-home", "memory", "index.sqlite"));
  });

  it("moves the task database, which holds the message bus", async () => {
    // A queue shared between bench instances handed one run's prompt
    // to the next instance.
    process.env.FLINT_DATA_DIR = path.join(process.cwd(), "tmp-bench-home");
    const { tasksDbPath } = await import("../../src/tasks/db.js");
    expect(tasksDbPath()).toBe(path.join(process.cwd(), "tmp-bench-home", "tasks.db"));
  });

  it("leaves both where they were when it is not set", async () => {
    delete process.env.FLINT_DATA_DIR;
    const { config } = await import("../../src/config.js");
    const { memoryDbPath } = await import("../../src/memory/sqlite-store.js");
    expect(config.sessionsDir).not.toContain("tmp-bench-home");
    expect(memoryDbPath()).not.toContain("tmp-bench-home");
    expect(memoryDbPath()).toContain(path.join(".flint", "memory"));
  });
});

describe("an explicitly named port", () => {
  it("is reported as explicit so the server can refuse to move off it", async () => {
    const argv = process.argv;
    process.argv = [...argv.slice(0, 2), "--port", "3001"];
    try {
      const { config } = await import("../../src/config.js");
      expect(config.port).toBe(3001);
      expect(config.portExplicit).toBe(true);
    } finally {
      process.argv = argv;
    }
  });

  it("is not explicit when nobody asked for one", async () => {
    const { config } = await import("../../src/config.js");
    expect(config.portExplicit).toBe(false);
  });
});
