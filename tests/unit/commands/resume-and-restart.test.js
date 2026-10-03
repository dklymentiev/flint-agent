// /resume picks a recent session to continue; a restart continues the session
// it interrupted (owner, 2026-10-02: an investigation in progress was cut off
// by a restart, which always started a new session).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import React from "react";
import { render } from "ink-testing-library";

vi.mock("../../../src/logging/logger.js", () => ({
  createLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
}));

const { config } = await import("../../../src/config.js");
const { saveSession } = await import("../../../src/sessions.js");
const { restartKeepingSession, RESTART_CODE } = await import("../../../src/restart.js");
const { OverlayMenu, fitEnd, sessionWhen } = await import("../../../src/components/OverlayMenu.js");

async function setup() {
  const { createMockStore } = await import("../../helpers/mock-store.js");
  const { initCommands, tryHandleCommand } = await import("../../../src/commands/registry.js");
  const store = createMockStore();
  initCommands(store);
  return { store, run: (c) => tryHandleCommand(c, store) };
}

const session = (id, userTexts, updated) => saveSession(id, {
  messages: [{ role: "system", content: "sys" }, ...userTexts.flatMap((t) => [{ role: "user", content: t }, { role: "assistant", content: "ok" }])],
  model: "m",
}).then(async () => {
  // saveSession stamps "updated" with now; order the list by hand.
  const fs = await import("node:fs/promises");
  const f = path.join(config.sessionsDir, `${id}.json`);
  const d = JSON.parse(await fs.readFile(f, "utf8"));
  d.updated = updated;
  await fs.writeFile(f, JSON.stringify(d));
});

beforeEach(() => {
  config.sessionsDir = mkdtempSync(path.join(tmpdir(), "flint-resume-"));
});

describe("/resume", () => {
  it("lists the other sessions, newest first, with the last thing asked in each", async () => {
    await session("2026-10-02T10-00-00", ["old task"], "2026-10-02T10:05:00Z");
    await session("2026-10-02T14-11-21", ["find the Node LTS", "find about dots from openai now", "write the plan to C:\\tmp\\dots"], "2026-10-02T14:40:00Z");
    await session("2026-10-02T14-11-08", [], "2026-10-02T14:11:08Z");   // nothing asked: left out
    const { store, run } = await setup();
    store.getState().setSession("2026-10-02T15-00-00", [], []);
    expect(await run("/resume")).toBe(true);
    const o = store.getState().overlay;
    expect(o.type).toBe("session");
    expect(o.items.map((i) => i.id)).toEqual(["2026-10-02T14-11-21", "2026-10-02T10-00-00"]);
    expect(o.items[0]).toMatchObject({ count: 3, last: "write the plan to C:\\tmp\\dots" });
  });

  it("/resume <id> loads that session, like /load", async () => {
    // Saved as is: the session file is signed (HMAC), and the ordering helper's
    // rewrite would make it fail the check on load.
    await saveSession("2026-10-02T14-11-21", {
      messages: [{ role: "system", content: "sys" }, { role: "user", content: "find about dots from openai now" }],
      model: "m",
    });
    const { store, run } = await setup();
    expect(await run("/resume 2026-10-02T14-11-21")).toBe(true);
    expect(store.getState().sessionId).toBe("2026-10-02T14-11-21");
    expect(store.getState().messages.some((m) => m.content === "find about dots from openai now")).toBe(true);
  });

  it("draws one row per session: when, how many messages, the last message cut to fit", () => {
    const when = new Date(2026, 9, 2, 14, 40);
    const { lastFrame } = render(React.createElement(OverlayMenu, {
      height: 12,
      overlay: { type: "session", title: "Resume a session", index: 0, items: [
        { id: "a", when, count: 3, last: "write the plan to C:\\tmp\\dots and the collected information " + "x".repeat(300) },
      ] },
    }));
    const frame = lastFrame();
    expect(frame).toContain("Resume a session");
    expect(frame).toContain("10-02 14:40");
    expect(frame).toContain("write the plan to C:\\tmp\\dots");
    expect(frame).toContain("…");
    expect(fitEnd("привет мир", 7)).toBe("привет…");
    expect(sessionWhen(null)).toBe("");
  });
});

describe("restart keeps the session", () => {
  it("tells the launcher which session, then exits 42 once the message is sent", async () => {
    const calls = [];
    const proc = {
      connected: true,
      send: (msg, cb) => { calls.push(["send", msg]); setTimeout(cb, 5); },
      exit: (code) => calls.push(["exit", code]),
    };
    restartKeepingSession("2026-10-02T14-11-21", 0, proc);
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toEqual([
      ["send", { type: "flint:restart", sessionId: "2026-10-02T14-11-21" }],
      ["exit", RESTART_CODE],
    ]);
  });

  it("without a launcher it is a plain exit 42", async () => {
    const calls = [];
    restartKeepingSession("s", 0, { exit: (code) => calls.push(code) });
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toEqual([42]);
  });
});

const { chatLogTail, replaySessionTail } = await import("../../../src/ui/replay.js");
const { createChatLogFollower } = await import("../../../src/logging/chat-log-follower.js");
const { estimateContextTokens } = await import("../../../src/store/session-slice.js");
const { statusText } = await import("../../../src/components/LiveZone.js");
const fs = await import("node:fs");

describe("a continued session shows where it got to", () => {

  const writeLog = (id, lines) => fs.writeFileSync(path.join(config.sessionsDir, `${id}.chat.log`),
    lines.map((l, i) => `[14:${String(i % 60).padStart(2, "0")}:00] ${l}`).join("\n") + "\n\n");

  it("the tail of the chat log, without time stamps or trailing blanks", () => {
    writeLog("s1", Array.from({ length: 120 }, (_, i) => `line ${i}`));
    const tail = chatLogTail("s1", 80);
    expect(tail).toHaveLength(80);
    expect(tail[0]).toBe("line 40");
    expect(tail.at(-1)).toBe("line 119");
    expect(chatLogTail("no-such-session")).toEqual([]);
  });

  it("leaves out leaving and loading the session and the start banner, and opens at a typed message", () => {
    // What the first real resume showed (owner, 2026-10-02).
    writeLog("s5", [
      "  account yet.\"",
      "      ── turn 5 · 2 tools · 161.8k in / 1.2k out tok · 15.9s ──",
      " > say same in ru",
      "  Это не отдельный продукт",
      "  Loaded session s5 (8 messages, 43 facts)",
      " > exit",
      "Session saved: s5",
      "Bye!",
      "   \\ /",
      " -[°^°]- FLINT AGENT v1.9.1",
      // The banner since 1.14: the two-row FLiNT mark.
      " ▀▀▀ █   ▀ █▄ █ ▀█▀",
      " █▀▀ █▄▄ █ █ ▀█  █   v1.14.0",
      " model:   stealth/space-bunny-alpha  |  provider: openrouter",
      " session: s5 (87 msgs)",
      " type /help for commands, \"exit\" to quit",
      "  mcp: screenbox connected (23 tools)",
      " > /resume",
      " > ok where we are?",
      "  Phase 4 is next.",
    ]);
    expect(chatLogTail("s5")).toEqual([
      " > say same in ru",
      "  Это не отдельный продукт",
      " > ok where we are?",
      "  Phase 4 is next.",
    ]);
  });

  it("is shown in the history but not written to the chat log a second time", async () => {
    writeLog("s2", ["> find about dots", "  Found it: Introducing dots"]);
    const { createMockStore } = await import("../../helpers/mock-store.js");
    const store = createMockStore();
    store.getState().setSession("s2", [], []);
    const logged = [];
    const follower = createChatLogFollower({
      getState: () => store.getState(), subscribe: (fn) => store.subscribe(fn), log: (_, t) => logged.push(t),
    });
    follower.start();
    expect(replaySessionTail(store, "s2")).toBe(2);
    store.getState().addLine("a new line");
    const shown = store.getState().lines.map((l) => String(l.text));
    expect(shown.some((t) => t.includes("Found it: Introducing dots"))).toBe(true);
    expect(logged).toEqual(["a new line"]);
  });

  it("/load puts the tail on screen", async () => {
    await saveSession("s3", { messages: [{ role: "system", content: "sys" }, { role: "user", content: "hi" }], model: "m" });
    writeLog("s3", ["> hi", "  earlier answer"]);
    const { store, run } = await setup();
    await run("/load s3");
    expect(store.getState().lines.map((l) => String(l.text)).join("\n")).toContain("earlier answer");
  });

  it("the context counter shows an estimate, marked ~, until the model answers", async () => {
    const msgs = [{ role: "system", content: "x".repeat(4000) }, { role: "user", content: "y".repeat(400) }];
    expect(estimateContextTokens(msgs)).toBe(1100);
    const { createMockStore } = await import("../../helpers/mock-store.js");
    const store = createMockStore();
    store.getState().setSession("s4", msgs, []);
    const s = store.getState();
    expect(s.lastContextTokens).toBe(1100);
    expect(s.contextEstimated).toBe(true);
    expect(statusText({ contextTokens: 1100, contextLimit: 1_000_000, contextEstimated: true })).toContain("ctx ~1k/1M");
    expect(statusText({ contextTokens: 1100, contextLimit: 1_000_000, contextEstimated: false })).not.toContain("~");
  });
});
