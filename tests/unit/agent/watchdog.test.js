// The first answer, and the clock on it.
//
// A call sent at 20:40:49 on 2026-09-29 never returned. The 10-minute timeout
// fired at 20:50:49, the call was retried, and for the whole ten minutes the
// console said `thinking #15 468s` — the age of the task, not of the call.
//
// The watchdog exists so the second half of that does not happen twice.

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  callWithStallWatchdog, firstTokenTimeoutMs, maxStallAttempts, stallNote, stallStopNote,
} from "../../../src/agent/watchdog.js";

afterEach(() => { vi.useRealTimers(); delete process.env.AGENT_FIRST_TOKEN_TIMEOUT_MS; });

describe("defaults", () => {
  it("drops a hung connection after 90 s", () => {
    expect(firstTokenTimeoutMs()).toBe(90_000);
  });

  it("allows three attempts before the turn stops", () => {
    expect(maxStallAttempts()).toBe(3);
  });

  it("takes an override from the environment", () => {
    process.env.AGENT_FIRST_TOKEN_TIMEOUT_MS = "1234";
    expect(firstTokenTimeoutMs()).toBe(1234);
  });
});

describe("stallNote", () => {
  it("names the silence, the fact it is retrying, and which attempt", () => {
    expect(stallNote(90, 1, 3)).toBe("no answer for 90s, retrying, 1 of 3");
  });
});

describe("stallStopNote", () => {
  it("says what stopped it, that nothing ran, and how to continue", () => {
    const note = stallStopNote(3, 90_000);
    expect(note).toContain("no answer for 90s");
    expect(note).toContain("3 attempts");
    expect(note).toContain("Nothing ran");
    expect(note).toContain("type: continue");
  });
});

describe("callWithStallWatchdog", () => {
  it("passes the answer through when the model answers in time", async () => {
    const out = await callWithStallWatchdog(
      async (onToken) => { onToken("hi"); return { ok: true }; },
      { timeoutMs: 1000 },
    );
    expect(out).toEqual({ ok: true });
  });

  it("forwards tokens to the caller", async () => {
    const seen = [];
    await callWithStallWatchdog(
      async (onToken) => { onToken("he"); onToken("llo"); return 1; },
      { timeoutMs: 1000, onToken: (t) => seen.push(t) },
    );
    expect(seen).toEqual(["he", "llo"]);
  });

  it("gives up on a call that never answers, and aborts it", async () => {
    vi.useFakeTimers();
    let sawAbort = false;
    const p = callWithStallWatchdog(
      (_onToken, signal) => new Promise((resolve) => {
        signal.addEventListener("abort", () => { sawAbort = true; resolve("ignored"); });
      }),
      { timeoutMs: 90_000 },
    );
    const assertion = expect(p).rejects.toMatchObject({ isStall: true });
    await vi.advanceTimersByTimeAsync(90_001);
    await assertion;
    // The request is aborted, not merely abandoned: an abandoned promise still
    // holds an open socket, and two of them were still open on 2026-09-29 when
    // the retries started.
    expect(sawAbort).toBe(true);
  });

  it("stops timing once the first token arrives", async () => {
    vi.useFakeTimers();
    let firstTokenAt = null;
    const p = callWithStallWatchdog(
      async (onToken) => {
        await new Promise((r) => setTimeout(r, 1_000));
        onToken("started writing");
        // Takes far longer than the watchdog would have allowed.
        await new Promise((r) => setTimeout(r, 300_000));
        return "answered";
      },
      { timeoutMs: 90_000, onFirstToken: () => { firstTokenAt = Date.now(); } },
    );
    await vi.advanceTimersByTimeAsync(400_000);
    expect(await p).toBe("answered");
    expect(firstTokenAt).not.toBeNull();
  });

  it("does not fire the watchdog on a call that already ended", async () => {
    vi.useFakeTimers();
    const p = callWithStallWatchdog(async () => "fast", { timeoutMs: 90_000 });
    await vi.advanceTimersByTimeAsync(200_000);
    expect(await p).toBe("fast");
  });

  it("aborts when the caller aborts", async () => {
    const controller = new AbortController();
    const p = callWithStallWatchdog(
      (_onToken, signal) => new Promise((resolve) => {
        signal.addEventListener("abort", () => resolve("aborted"));
      }),
      { timeoutMs: 90_000, signal: controller.signal },
    );
    controller.abort();
    expect(await p).toBe("aborted");
  });
});