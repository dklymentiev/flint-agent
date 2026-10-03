// A tool call the model wrote as text is not progress.
//
// On 2026-09-29 a turn classified `chat` (0 tools, 1 step) came back with the
// tool call inside the answer:
//
//   <tool_call><function=edit_file>{...9 KB...}</tool_call>
//
// None of it ran. All of it streamed to the console as if it were work being
// done, the turn returned `done`, and only /new recovered the session.
//
// Every sample below is built with an explicit \u200b escape rather than a
// literal zero-width space. A literal one is invisible in an editor, invisible
// in a diff, and stripped by anything that round-trips the file -- which is
// half of why the thing is hard to handle.

import { describe, it, expect } from "vitest";
import { findTextToolCalls, looksLikeTextToolCall, toolCallTextNote } from "../../../src/agent/toolcall-text.js";

const ZW = "\u200b"; // the invisible character, written as an escape
const OPEN = `<${ZW}tool_call>`;
const CLOSE = `<${ZW}/tool_call>`;

describe("looksLikeTextToolCall", () => {
  it("sees the function-tag shape", () => {
    expect(looksLikeTextToolCall(`Here is the change:${OPEN}<function=edit_file>{}</function>${CLOSE}`)).toBe(true);
  });

  it("sees the JSON-body shape", () => {
    expect(looksLikeTextToolCall(`${OPEN}{"name":"write_file","arguments":{}}${CLOSE}`)).toBe(true);
  });

  it("sees the same tags with no zero-width character", () => {
    expect(looksLikeTextToolCall("<tool_call><function=edit_file>{}</tool_call>")).toBe(true);
  });

  it("leaves an ordinary answer alone", () => {
    expect(looksLikeTextToolCall("The tests pass and the diff is small.")).toBe(false);
  });
});

describe("findTextToolCalls", () => {
  it("reads the name and arguments out of the function-tag shape", () => {
    const calls = findTextToolCalls(
      `${OPEN}<function=edit_file>{"path":"src/a.js"}</function>${CLOSE}`,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("edit_file");
    expect(calls[0].args).toContain("src/a.js");
  });

  it("reads the JSON-body shape", () => {
    const calls = findTextToolCalls(
      `${OPEN}{"name":"run_command","arguments":{"command":"npx vitest run"}}${CLOSE}`,
    );
    expect(calls[0].name).toBe("run_command");
    expect(calls[0].args).toContain("npx vitest run");
  });

  it("names a call whose arguments were truncated instead of dropping it", () => {
    const calls = findTextToolCalls(`${OPEN}<function=edit_file>{"path":"a.js","content":"half`);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("edit_file");
    expect(calls[0].args).toContain("half");
  });

  it("reports an unreadable JSON body rather than pretending there was none", () => {
    const calls = findTextToolCalls(`${OPEN}{"name": broken${CLOSE}`);
    expect(calls).toHaveLength(1);
  });

  it("finds several calls, not just the first", () => {
    const calls = findTextToolCalls(
      `${OPEN}<function=write_file>{"path":"a"}</function>${CLOSE}` +
      `${OPEN}<function=run_command>{"command":"npx vitest run"}</function>${CLOSE}`,
    );
    expect(calls.map((c) => c.name)).toEqual(["write_file", "run_command"]);
  });

  it("returns nothing for an ordinary answer", () => {
    expect(findTextToolCalls("All done, nothing to see here.")).toEqual([]);
  });
});

describe("toolCallTextNote", () => {
  it("says nothing ran, and never says the work was done", () => {
    const note = toolCallTextNote([{ name: "edit_file", args: "{}" }]);
    expect(note).toContain("nothing ran");
    expect(note).toContain("edit_file");
    expect(note).not.toMatch(/\b(done|completed|fixed)\b/i);
  });

  it("counts the repeats when the model did it again after being told", () => {
    const note = toolCallTextNote([{ name: "edit_file", args: "{}" }], { attempts: 1 });
    expect(note).toContain("2 times in a row");
  });
});