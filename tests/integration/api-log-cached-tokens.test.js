// Integration test: api.log usage line must carry cached token counts.
//
// Providers (OpenRouter, OpenAI) return prompt_tokens_details with
// cached_tokens and cache_write_tokens inside the usage object. Without
// those numbers in the log, the session cost cannot be audited: a cache hit
// bills at roughly 1/120th the rate of a miss, so "prompt=1000" without
// saying how many of those were cached hides real spend.
//
// This test calls the REAL logApiCall (from src/logging/api-log.js) with a
// usage object that carries cached-token details, then reads back the
// generated <sessionId>.api.log and asserts the cached counts appear.
import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createTmpDir } from "../helpers/tmp-dir.js";

let tmp;

// Mock config so sessionsDir lands in a temp dir, not the install dir.
// logApiCall reads config.sessionsDir at module load of api-log.js, so the
// mock must be hoisted above the import.
const SESSION_ID = "test-cached-tokens-session";

vi.mock("../../src/config.js", () => {
  tmp = createTmpDir();
  return {
    config: {
      sessionsDir: tmp.path,
    },
  };
});

// Import after mocking so config is resolved from the mock above.
const { logApiCall } = await import("../../src/logging/api-log.js");

describe("api.log cached token counts", () => {
  it("includes cached_tokens and cache_write_tokens in the Usage line", async () => {
    const usage = {
      prompt_tokens: 1000,
      completion_tokens: 200,
      prompt_tokens_details: {
        cached_tokens: 800,
        cache_write_tokens: 150,
      },
      cost: 0.0023,
    };

    const reply = { role: "assistant", content: "Hello from the model" };

    // First the request side (messages present)
    logApiCall(SESSION_ID, 1, [
      { role: "system", content: "You are helpful" },
      { role: "user", content: "Hello" },
    ], [], null, usage);

    // Then the response side (reply + usage)
    logApiCall(SESSION_ID, 1, null, null, reply, usage);

    const logFile = path.join(tmp.path, `${SESSION_ID}.api.log`);
    const content = fs.readFileSync(logFile, "utf-8");

    // The prompt and completion counts must still be present.
    expect(content).toContain("prompt=1000");
    expect(content).toContain("completion=200");

    // Cached tokens and cache writes must be present in the Usage line.
    // These are the numbers the provider reports for cache hits / cache writes.
    expect(content).toMatch(/cached=800/);
    expect(content).toMatch(/cache_write=150/);

    tmp.cleanup();
  });
});
