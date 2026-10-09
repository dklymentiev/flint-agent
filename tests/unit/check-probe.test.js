// The --check probe (src/check-probe.js) with a stand-in model and a stand-in
// tool runner: what it sends back to the model, what it runs, what it exits
// with.
import { describe, it, expect, vi } from "vitest";
import { runCheckProbe, CHECK_OK, CHECK_NO_KEY, CHECK_NO_ANSWER, CHECK_NO_ROUND_TRIP } from "../../src/check-probe.js";

const task = {
  prompt: "run it",
  check: ({ answer, tools = [] }) => tools.some((t) => /run_command|shell/.test(t.name)) && /\b42\b/.test(answer),
};
const callOf = (id, name = "run_command", args = { command: "echo 42" }) =>
  ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });

function probe({ replies, runTool, hasKey = true }) {
  const seen = [];
  const chat = vi.fn(async (messages) => {
    seen.push(JSON.parse(JSON.stringify(messages)));
    const r = replies[seen.length - 1];
    if (r instanceof Error) throw r;
    return { message: r };
  });
  const tool = vi.fn(runTool || (async () => ({ content: "42\n", denied: false })));
  return {
    seen, chat, tool,
    run: () => runCheckProbe({ task, hasKey, chat, runTool: tool, dir: ".", provider: "p", model: "m" }),
  };
}

describe("runCheckProbe", () => {
  it("no key: 10, and the model is not called", async () => {
    const p = probe({ replies: [], hasKey: false });
    const r = await p.run();
    expect(r.code).toBe(CHECK_NO_KEY);
    expect(p.chat).not.toHaveBeenCalled();
  });

  it("the model does not answer: 11", async () => {
    const r = await probe({ replies: [new Error("boom")] }).run();
    expect(r.code).toBe(CHECK_NO_ANSWER);
  });

  it("an answer in words with no tool call: 12", async () => {
    const p = probe({ replies: [{ role: "assistant", content: "it is 42" }] });
    const r = await p.run();
    expect(r.code).toBe(CHECK_NO_ROUND_TRIP);
    expect(p.tool).not.toHaveBeenCalled();
  });

  it("the command goes through the tool runner, and its output goes back under the call's id", async () => {
    const p = probe({ replies: [{ role: "assistant", content: "", tool_calls: [callOf("c1")] }, { role: "assistant", content: "42" }] });
    const r = await p.run();
    expect(p.tool).toHaveBeenCalledWith("run_command", { command: "echo 42" });
    expect(p.seen[1].filter((m) => m.role === "tool")).toEqual([{ role: "tool", tool_call_id: "c1", content: "42" }]);
    expect(r.code).toBe(CHECK_OK);
    expect(r.stdout).toMatch(/^check ok: key=p model=m/);
  });

  it("a refused command: 12, said in the output, and no second model call", async () => {
    const p = probe({
      replies: [{ role: "assistant", content: "", tool_calls: [callOf("c1", "run_command", { command: "rm -r x" })] }],
      runTool: async () => ({ content: 'Tool "run_command" was not run: it needs the operator\'s approval', denied: true }),
    });
    const r = await p.run();
    expect(r.code).toBe(CHECK_NO_ROUND_TRIP);
    expect(r.stdout).toMatch(/refused and not run/);
    expect(p.chat).toHaveBeenCalledTimes(1);
  });

  it("two tool calls: both run, both answered, each under its own id", async () => {
    const p = probe({ replies: [{ role: "assistant", content: "", tool_calls: [callOf("c1"), callOf("c2")] }, { role: "assistant", content: "42" }] });
    const r = await p.run();
    expect(p.tool).toHaveBeenCalledTimes(2);
    expect(p.seen[1].filter((m) => m.role === "tool").map((m) => m.tool_call_id)).toEqual(["c1", "c2"]);
    expect(r.code).toBe(CHECK_OK);
  });

  it("a tool that is not a command is answered and not run", async () => {
    const p = probe({
      replies: [{ role: "assistant", content: "", tool_calls: [callOf("c1", "write_file", { path: "a", content: "b" }), callOf("c2", "shell")] }, { role: "assistant", content: "42" }],
    });
    const r = await p.run();
    expect(p.tool).toHaveBeenCalledTimes(1);
    expect(p.tool).toHaveBeenCalledWith("shell", { command: "echo 42" });
    const answers = p.seen[1].filter((m) => m.role === "tool");
    expect(answers.map((m) => m.tool_call_id)).toEqual(["c1", "c2"]);
    expect(answers[0].content).toMatch(/was not run/);
    expect(r.code).toBe(CHECK_OK);
  });

  it("calls without ids are given ids, the same in the assistant message and in the answers", async () => {
    const noId = (c) => { const { id, ...rest } = c; return rest; };
    const p = probe({ replies: [{ role: "assistant", content: "", tool_calls: [noId(callOf("x")), noId(callOf("y"))] }, { role: "assistant", content: "42" }] });
    await p.run();
    const assistant = p.seen[1].find((m) => m.role === "assistant");
    const answers = p.seen[1].filter((m) => m.role === "tool");
    expect(assistant.tool_calls.map((t) => t.id)).toEqual(["call_1", "call_2"]);
    expect(answers.map((m) => m.tool_call_id)).toEqual(["call_1", "call_2"]);
  });

  it("a wrong final answer: 12; no answer after the tool result: 11", async () => {
    const first = { role: "assistant", content: "", tool_calls: [callOf("c1")] };
    expect((await probe({ replies: [first, { role: "assistant", content: "41" }] }).run()).code).toBe(CHECK_NO_ROUND_TRIP);
    expect((await probe({ replies: [first, new Error("400")] }).run()).code).toBe(CHECK_NO_ANSWER);
  });
});
