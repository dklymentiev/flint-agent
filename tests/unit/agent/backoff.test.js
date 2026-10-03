// The waiting Flint should be doing itself.
//
// Two failures that used to end the turn immediately and leave the operator to
// type "continue":
//
//   - the model answers with nothing, several times running (each one billed)
//   - the provider refuses with a temporary error: a 429, or the 400 that an
//     overloaded backend sends with "rate-limited upstream" in the body

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  EMPTY_RETRY_LIMIT, backoffBaseMs, backoffMs, describeProviderError, formatCountdown,
  isTemporaryProviderError, sleepWithCountdown, tempErrorRetryLimit, waitNotice,
} from "../../../src/agent/backoff.js";

afterEach(() => { vi.useRealTimers(); delete process.env.AGENT_BACKOFF_MS; delete process.env.AGENT_TEMP_ERROR_RETRIES; });

describe("backoffMs", () => {
  it("starts at 30 s", () => {
    expect(backoffMs(1)).toBe(30_000);
  });

  it("doubles: 30 s, 1 min, 2 min", () => {
    expect(backoffMs(1)).toBe(30_000);
    expect(backoffMs(2)).toBe(60_000);
    expect(backoffMs(3)).toBe(120_000);
  });

  it("caps at two minutes rather than growing without bound", () => {
    expect(backoffMs(9)).toBe(120_000);
  });

  it("does not shrink when the attempt number goes up", () => {
    let last = 0;
    for (let a = 1; a <= 8; a++) {
      const now = backoffMs(a);
      expect(now).toBeGreaterThanOrEqual(last);
      last = now;
    }
  });

  it("takes a base from the environment", () => {
    process.env.AGENT_BACKOFF_MS = "1000";
    expect(backoffBaseMs()).toBe(1000);
    expect(backoffMs(1)).toBe(1000);
  });
});

describe("formatCountdown", () => {
  it("reads as minutes and seconds", () => {
    expect(formatCountdown(45_000)).toBe("0:45");
    expect(formatCountdown(120_000)).toBe("2:00");
  });

  it("rounds up, so a countdown never shows 0:00 while still waiting", () => {
    expect(formatCountdown(1)).toBe("0:01");
  });
});

describe("waitNotice", () => {
  it("says what is wrong, when the next try is, and how to stop it", () => {
    const line = waitNotice("the model is not answering", 45_000);
    expect(line).toContain("the model is not answering");
    expect(line).toContain("0:45");
    expect(line).toContain("Esc to stop");
  });
});

describe("limits", () => {
  it("gives up on three empty answers", () => {
    expect(EMPTY_RETRY_LIMIT).toBe(3);
  });

  it("waits out three temporary refusals", () => {
    expect(tempErrorRetryLimit()).toBe(3);
  });
});

describe("isTemporaryProviderError", () => {
  it("treats a 429 as 'not now'", () => {
    expect(isTemporaryProviderError({ isRateLimit: true, statusCode: 429 })).toBe(true);
  });

  it("treats a 400 that says rate-limited upstream as an overloaded backend", () => {
    const err = Object.assign(new Error("API 400: Provider returned error 'rate-limited upstream'"), { statusCode: 400 });
    expect(isTemporaryProviderError(err)).toBe(true);
  });

  it("treats a plain 400 — a malformed request — as fatal", () => {
    const err = Object.assign(new Error("API 400: messages must not be empty"), { statusCode: 400 });
    expect(isTemporaryProviderError(err)).toBe(false);
  });

  it("treats a 5xx as temporary", () => {
    expect(isTemporaryProviderError({ statusCode: 503 })).toBe(true);
  });

  it("does NOT wait out a bad key, an empty account, or our own budget", () => {
    expect(isTemporaryProviderError({ isAuthError: true, statusCode: 401 })).toBe(false);
    expect(isTemporaryProviderError({ isQuotaError: true, statusCode: 402 })).toBe(false);
    expect(isTemporaryProviderError({ isBudgetError: true })).toBe(false);
  });

  it("does not wait out the operator pressing Esc, or a dropped call", () => {
    expect(isTemporaryProviderError({ name: "AbortError" })).toBe(false);
    expect(isTemporaryProviderError({ isStall: true })).toBe(false);
  });
});

describe("describeProviderError", () => {
  it("names the rate limit rather than the number alone", () => {
    expect(describeProviderError({ isRateLimit: true, statusCode: 429 })).toContain("429");
  });

  it("recognises an overloaded upstream", () => {
    const err = Object.assign(new Error("API 400: rate-limited upstream"), { statusCode: 400 });
    expect(describeProviderError(err)).toContain("overloaded");
  });
});

describe("sleepWithCountdown", () => {
  it("counts down and resolves when the pause is over", async () => {
    vi.useFakeTimers();
    const ticks = [];
    const p = sleepWithCountdown(3000, { onTick: (left) => ticks.push(left), tickMs: 1000 });
    await vi.advanceTimersByTimeAsync(3000);
    expect(await p).toBe(true);
    expect(ticks[0]).toBe(3000);
    expect(ticks[ticks.length - 1]).toBe(0);
  });

  it("resolves false — not true — when the abort cuts the pause short", async () => {
    // The caller must not treat "aborted" as "waited", or a turn stopped with
    // Esc carries on talking to the provider behind the operator's back.
    const controller = new AbortController();
    let waited;
    const p = sleepWithCountdown(60_000, { signal: controller.signal, tickMs: 100 }).then((r) => { waited = r; });
    controller.abort();
    await p;
    expect(waited).toBe(false);
  });

  it("does not wait at all when there is nothing to wait for", async () => {
    expect(await sleepWithCountdown(0)).toBe(true);
  });
});