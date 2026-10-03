/**
 * Functional tests: large file handling without OOM.
 *
 * Strategy: create small files with real content but mock fs.stat to report
 * huge sizes (1 GB). This triggers the streaming code path without needing
 * actual large files on disk. For web_fetch tests, use a real HTTP server.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createSystemTools } from "../../src/tools/system.js";
import { createMockStore } from "../helpers/mock-store.js";
import { createTmpDir } from "../helpers/tmp-dir.js";
import fsSync from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import http from "node:http";

const FILE_COUNT = 20;
const FAKE_SIZE = 1024 * 1024 * 1024; // 1 GB (reported, not actual)
const LINES_PER_FILE = 200;

let tmp;

// ── Helpers ──────────────────────────────────────────────────

function createTestFile(filePath, lineCount) {
  const lines = Array.from({ length: lineCount }, (_, i) =>
    `line-${String(i).padStart(6, "0")}: The quick brown fox jumps over the lazy dog`
  );
  fsSync.writeFileSync(filePath, lines.join("\n") + "\n", "utf-8");
}

// Capture real stat ONCE before any mocking
const realStat = fsPromises.stat.bind(fsPromises);

/**
 * Mock fs.stat to report fakeSize for files in tmp dir.
 * Uses the captured real stat to avoid infinite recursion.
 */
async function getHandlersWithMockedStat(fakeSize) {
  vi.spyOn(fsPromises, "stat").mockImplementation(async (p, ...args) => {
    const real = await realStat(p, ...args);
    const resolved = path.resolve(String(p));
    if (resolved.startsWith(tmp.path)) {
      return { ...real, size: fakeSize };
    }
    return real;
  });

  const mod = await import("../../src/tools/filesystem.js");
  return mod.handlers;
}

// ── Setup ────────────────────────────────────────────────────

beforeAll(() => {
  tmp = createTmpDir();
  for (let i = 0; i < FILE_COUNT; i++) {
    const name = `bigfile-${String(i).padStart(2, "0")}.log`;
    createTestFile(path.join(tmp.path, name), LINES_PER_FILE);
  }
});

afterAll(() => {
  vi.restoreAllMocks();
  tmp.cleanup();
});

// ── Tests: read_file on "large" files ────────────────────────

describe("read_file: 20 files reported as 1 GB each", () => {
  it("reports large file with auto-preview", async () => {
    const handlers = await getHandlersWithMockedStat(FAKE_SIZE);
    const file = path.join(tmp.path, "bigfile-00.log");
    const result = await handlers.read_file({ path: file });
    expect(result).toContain("Large file");
    expect(result).toContain("1024.0 MB");
    expect(result).toContain("Auto-preview");
    expect(result).toContain("line-000000");
    expect(result).toContain("line-000019"); // first 20 lines
  });

  it("reads specific chunk via offset/limit", async () => {
    const handlers = await getHandlersWithMockedStat(FAKE_SIZE);
    const file = path.join(tmp.path, "bigfile-00.log");
    const result = await handlers.read_file({ path: file, offset: 5, limit: 10 });
    expect(result).toContain("Large file");
    expect(result).toContain("line-000005");
    expect(result).toContain("line-000014");
    expect(result).not.toContain("line-000004:");
  });

  it("reads all 20 files sequentially", async () => {
    const handlers = await getHandlersWithMockedStat(FAKE_SIZE);
    const results = [];
    for (let i = 0; i < FILE_COUNT; i++) {
      const file = path.join(tmp.path, `bigfile-${String(i).padStart(2, "0")}.log`);
      results.push(await handlers.read_file({ path: file }));
    }
    for (const r of results) {
      expect(r).toContain("Large file");
      expect(r).toContain("Auto-preview");
      expect(r).toContain("line-000000");
    }
  });

  it("reads all 20 files in PARALLEL", async () => {
    const handlers = await getHandlersWithMockedStat(FAKE_SIZE);
    const promises = Array.from({ length: FILE_COUNT }, (_, i) => {
      const file = path.join(tmp.path, `bigfile-${String(i).padStart(2, "0")}.log`);
      return handlers.read_file({ path: file });
    });
    const results = await Promise.all(promises);
    for (const r of results) {
      expect(r).toContain("Large file");
      expect(r).toContain("Auto-preview");
    }
  });

  it("reads chunks from all 20 files in parallel", async () => {
    const handlers = await getHandlersWithMockedStat(FAKE_SIZE);
    const promises = Array.from({ length: FILE_COUNT }, (_, i) => {
      const file = path.join(tmp.path, `bigfile-${String(i).padStart(2, "0")}.log`);
      return handlers.read_file({ path: file, offset: 10, limit: 50 });
    });
    const results = await Promise.all(promises);
    for (const r of results) {
      expect(r).toContain("line-000010");
      expect(r).toContain("line-000059");
    }
  });
});

// ── Tests: web_fetch with large responses ────────────────────

describe("web_fetch: large download protection", () => {
  let server;
  let port;
  let sysHandlers;

  beforeAll(async () => {
    const store = createMockStore();
    sysHandlers = createSystemTools(store).handlers;

    server = http.createServer((req, res) => {
      if (req.url === "/small") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("Small response body");
        return;
      }

      if (req.url === "/large-header") {
        // Announces 500 MB via Content-Length
        res.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(500 * 1024 * 1024),
        });
        res.end("tiny");
        return;
      }

      if (req.url === "/large-stream") {
        // Streams 5 MB without content-length
        res.writeHead(200, { "Content-Type": "text/plain" });
        const chunk = "x".repeat(512 * 1024); // 512 KB chunks
        let sent = 0;
        const interval = setInterval(() => {
          if (sent >= 10) { // 10 × 512 KB = 5 MB
            clearInterval(interval);
            res.end();
            return;
          }
          res.write(chunk);
          sent++;
        }, 5);
        return;
      }

      res.writeHead(404);
      res.end("Not found");
    });

    await new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        port = server.address().port;
        resolve();
      });
    });
  });

  afterAll(() => {
    server?.close();
  });

  it("fetches small responses normally", async () => {
    const result = await sysHandlers.web_fetch({ url: `http://127.0.0.1:${port}/small` });
    expect(result).toContain("HTTP 200");
    expect(result).toContain("Small response body");
  });

  it("rejects response with large Content-Length header", async () => {
    const result = await sysHandlers.web_fetch({ url: `http://127.0.0.1:${port}/large-header` });
    expect(result).toContain("Large response");
    expect(result).toContain("500.0 MB");
    expect(result).toContain("curl/wget");
  });

  it("stops streaming at 2 MB cap", async () => {
    const result = await sysHandlers.web_fetch({ url: `http://127.0.0.1:${port}/large-stream` });
    expect(result).toContain("stopped at 2 MB");
    expect(result).toContain("curl/wget");
  });

  it("10 parallel large-header fetches all rejected", async () => {
    const promises = Array.from({ length: 10 }, () =>
      sysHandlers.web_fetch({ url: `http://127.0.0.1:${port}/large-header` })
    );
    const results = await Promise.all(promises);
    for (const r of results) {
      expect(r).toContain("Large response");
    }
  });

  it("10 parallel streaming fetches all capped", async () => {
    const promises = Array.from({ length: 10 }, () =>
      sysHandlers.web_fetch({ url: `http://127.0.0.1:${port}/large-stream` })
    );
    const results = await Promise.all(promises);
    for (const r of results) {
      expect(r).toContain("stopped at 2 MB");
    }
  });
});

// ── Tests: agent scenario ────────────────────────────────────

describe("agent scenario: 'read all files in directory X'", () => {
  it("list_directory then read_file each — all safe", async () => {
    const handlers = await getHandlersWithMockedStat(FAKE_SIZE);

    // Step 1: agent lists directory
    const listResult = await handlers.list_directory({ path: tmp.path });
    expect(listResult).toContain("bigfile-00.log");
    expect(listResult).toContain("bigfile-19.log");

    // Step 2: agent reads each file — gets preview, not crash
    const files = listResult.split("\n").filter((l) => l.includes("bigfile"));
    expect(files.length).toBe(FILE_COUNT);

    for (const line of files) {
      const fileName = line.trim().split(/\s+/).pop();
      const filePath = path.join(tmp.path, fileName);
      const result = await handlers.read_file({ path: filePath });
      expect(result).toContain("Large file");
      expect(result).toContain("Auto-preview");
      expect(result).toContain("line-000000");
    }
  });
});
