// What the model is sent between turns.
//
// Backlog item 4, both halves:
//
//   1. The default profile `generic` keeps only the last 20 messages
//      (`window(20)`). After a stop, "continue" lost what the turn had read.
//      The owner asked Flint to keep working on its own code and it had to be
//      told again what it had already done.
//
//   2. The window slices by message count and "can start with a tool result
//      whose tool call was cut off, which OpenAI-format providers reject with
//      400". Reproduced on the current code:
//
//        messages: system, user, assistant(tool_calls), tool, assistant
//        window(2) -> ["tool", "assistant"]      <- orphaned tool result
//        window(1) -> ["assistant"]              <- the tool_calls message
//
//      An orphaned tool result is not a shorter context, it is a rejected
//      request. The window is not allowed to produce one.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";

let buildContext, app, store, loadProfile;

const SYS = { role: "system", content: "system message" };

/** A system message plus a body, the shape buildContext is handed. */
function convo(...body) {
  return [SYS, ...body];
}

const user = (content) => ({ role: "user", content });
const assistant = (content) => ({ role: "assistant", content });
const toolCall = (id, name = "read_file") => ({
  role: "assistant",
  content: null,
  tool_calls: [{ id, function: { name, arguments: "{}" } }],
});
const toolResult = (id) => ({ role: "tool", tool_call_id: id, content: "contents" });

/**
 * Imported once, not per test.
 *
 * message-handler.js pulls in the store, the config, the agent loop and the
 * tool registry. Re-importing that graph in beforeEach — with vi.resetModules()
 * to get fresh singletons — took ~9s per test and ran the file straight into
 * the 10s hook timeout under load. The singletons do not need to be fresh:
 * every test sets app.profileConfig and store's lastSummary itself, which is
 * the only state buildContext reads.
 *
 * The explicit timeout is not slack: importing message-handler.js takes 7-9s
 * on this machine on its own (it pulls in the agent loop, the tool registry and
 * the config), and under the parallel load of a full run that crosses the 10s
 * default hook timeout and the file skips itself. Measured, not guessed.
 */
beforeAll(async () => {
  ({ buildContext } = await import("../../../src/message-handler.js"));
  ({ app } = await import("../../../src/app-state.js"));
  ({ store } = await import("../../../src/store/index.js"));
  ({ loadProfile } = await import("../../../src/profiles.js"));
}, 60000);

beforeEach(() => {
  app.systemMessage = SYS;
  app.profileConfig = { contextMode: "full", windowSize: 20 };
  store.setState({ lastSummary: null });
});

/** Set the profile the way a /profile command would. */
function useProfile(contextMode, windowSize) {
  app.profileConfig = { contextMode, windowSize };
}

/**
 * Every tool result must have its tool call in the same window, or the
 * provider is sent a result for a call it never saw.
 */
function orphanedToolResults(messages) {
  const open = new Set();
  const orphans = [];
  for (const m of messages) {
    if (m.role === "assistant" && m.tool_calls) {
      for (const tc of m.tool_calls) open.add(tc.id);
    } else if (m.role === "tool") {
      if (!open.has(m.tool_call_id)) orphans.push(m);
      else open.delete(m.tool_call_id);
    }
  }
  return orphans;
}

/** A tool call that was announced and never answered is a 400 of the other kind. */
function unansweredToolCalls(messages) {
  const open = new Set();
  for (const m of messages) {
    if (m.role === "assistant" && m.tool_calls) {
      for (const tc of m.tool_calls) open.add(tc.id);
    } else if (m.role === "tool" && open.has(m.tool_call_id)) {
      open.delete(m.tool_call_id);
    }
  }
  return [...open];
}

describe("full history by default", () => {
  it("keeps every message when the profile is full", () => {
    useProfile("full");
    const messages = convo(
      user("read the brief"),
      toolCall("c1"),
      toolResult("c1"),
      assistant("here is what it says"),
    );
    expect(buildContext(messages, user("continue"))).toBeNull();
  });

  it("the default generic profile is full, not a 20-message window", async () => {
    const { loadProfile } = await import("../../../src/profiles.js");
    const generic = loadProfile("generic");
    // window(20) is what lost the turn's work on 2026-09-30.
    expect(generic.contextMode).not.toBe("window");
  });

  it("a window keeps the system message, which the model needs to work at all", () => {
    useProfile("window", 2);
    const ctx = buildContext(convo(user("a"), assistant("b"), user("c")), user("d"));
    expect(ctx[0]).toBe(SYS);
  });
});

describe("a window never orphans a tool result", () => {
  it("does not start the window with a tool result whose call was cut off", () => {
    useProfile("window", 2);
    const messages = convo(
      user("do it"),
      toolCall("c1"),
      toolResult("c1"),
      assistant("ok"),
    );
    const ctx = buildContext(messages, user("continue"));
    // The current code sends ["tool", "assistant"] here.
    expect(orphanedToolResults(ctx)).toEqual([]);
  });

  it("keeps the tool call and its result together across the whole window", () => {
    useProfile("window", 3);
    const messages = convo(
      user("a"),
      toolCall("c1"),
      toolResult("c1"),
      toolCall("c2"),
      toolResult("c2"),
      assistant("done"),
    );
    const ctx = buildContext(messages, user("go on"));
    expect(orphanedToolResults(ctx)).toEqual([]);
    expect(unansweredToolCalls(ctx)).toEqual([]);
  });

  it("drops the whole pair rather than sending half of it", () => {
    // A window too small to hold both. Sending one without the other is the
    // 400; sending neither is a shorter but valid conversation.
    useProfile("window", 2);
    const messages = convo(user("a"), toolCall("c1"), toolResult("c1"), assistant("b"));
    const ctx = buildContext(messages, user("c"));
    const hasCall = ctx.some((m) => m.role === "assistant" && m.tool_calls?.length);
    const hasResult = ctx.some((m) => m.role === "tool");
    expect(hasCall && hasResult).toBe(false);
  });

  it("holds a still-running tool call without inventing a result", () => {
    // The turn called a tool and the window is taken before its result
    // arrived. Keeping the call alone is also invalid, and the loop appends
    // the result right after, so the pair is completed by the caller.
    useProfile("window", 4);
    const messages = convo(user("a"), toolCall("c1"), assistant("waiting"));
    const ctx = buildContext(messages, user("go on"));
    expect(orphanedToolResults(ctx)).toEqual([]);
  });

  it("survives a window of one with tool calls in the history", () => {
    for (const w of [1, 2, 3]) {
      useProfile("window", w);
      const messages = convo(
        user("a"),
        toolCall("c1"),
        toolResult("c1"),
        toolCall("c2"),
        toolResult("c2"),
        assistant("done"),
      );
      const ctx = buildContext(messages, user("next"));
      expect(orphanedToolResults(ctx), `window(${w})`).toEqual([]);
    }
  });
});

describe("window still saves tokens", () => {
  it("drops the oldest messages rather than keeping everything", () => {
    useProfile("window", 2);
    const messages = convo(
      user("first"),
      assistant("second"),
      user("third"),
      assistant("fourth"),
    );
    const ctx = buildContext(messages, user("fifth"));
    const bodies = ctx.filter((m) => m !== SYS).map((m) => m.content);
    expect(bodies).not.toContain("first");
    expect(bodies).toContain("fourth");
  });

  it("carries the session summary when one exists, so nothing is simply lost", () => {
    store.setState({ lastSummary: "the turn fixed the parser" });
    useProfile("window", 2);
    const messages = convo(user("first"), assistant("second"), user("third"));
    const ctx = buildContext(messages, user("fourth"));
    const text = ctx.map((m) => String(m.content || "")).join("\n");
    expect(text).toContain("the turn fixed the parser");
  });

  it("mini mode is still just the new message plus the summary", () => {
    store.setState({ lastSummary: "prior work" });
    useProfile("mini");
    const ctx = buildContext(convo(user("old"), assistant("older")), user("new one"));
    const bodies = ctx.filter((m) => m !== SYS);
    expect(bodies).toHaveLength(3); // summary pair + the message
    expect(bodies[2].content).toBe("new one");
  });
});