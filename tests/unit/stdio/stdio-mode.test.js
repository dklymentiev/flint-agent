// The stdio mode: Flint driven as a subprocess over stream-json
// (src/stdio). Flags, protocol shapes, the turn loop, the host's
// instructions and the .mcp.json servers.
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseStdioArgs, isSafeSessionId } from "../../../src/stdio/args.js";
import {
  userContent, assistantEvent, toolResultEvent, resultSubtype, resultEvent, parseInputLine, TOOL_RESULT_MAX_CHARS,
} from "../../../src/stdio/protocol.js";
import { createStdioSession, visibleTextStream, claudeMdChain, hostPromptFrom, mcpConfigPath } from "../../../src/stdio/session.js";
import { mcpJsonServers, parseServerConfig } from "../../../src/mcp-client.js";

const argv = (...a) => ["node", "flint", ...a];
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("flags", () => {
  it("takes the command line a host gives claude", () => {
    const o = parseStdioArgs(argv("--print", "--verbose", "--model", "stealth/space-bunny-alpha",
      "--input-format", "stream-json", "--output-format", "stream-json",
      "--session-id", "0b7c4c8e-1f2a-4d3b-9c8d-1234567890ab", "--dangerously-skip-permissions",
      "--system-prompt-file", "/proc/self/fd/3"));
    expect(o).toMatchObject({
      model: "stealth/space-bunny-alpha", sessionId: "0b7c4c8e-1f2a-4d3b-9c8d-1234567890ab",
      resume: false, skipPermissions: true, systemPromptFile: "/proc/self/fd/3",
    });
  });

  it("--resume names the session and marks it a resume", () => {
    const o = parseStdioArgs(argv("--stdio", "--resume", "abc-123"));
    expect(o).toMatchObject({ sessionId: "abc-123", resume: true });
  });

  it("is off without --stdio or stream-json, so the terminal mode is untouched", () => {
    expect(parseStdioArgs(argv())).toBeNull();
    expect(parseStdioArgs(argv("--headless", "--task", "x"))).toBeNull();
    expect(parseStdioArgs(argv("--model", "x"))).toBeNull();
  });

  it("refuses other formats and unsafe session ids rather than ignoring them", () => {
    expect(() => parseStdioArgs(argv("--input-format", "stream-json", "--output-format", "json"))).toThrow(/stream-json/);
    expect(() => parseStdioArgs(argv("--stdio", "--session-id", "../../etc/passwd"))).toThrow(/session id/);
    expect(isSafeSessionId("0b7c4c8e-1f2a-4d3b-9c8d-1234567890ab")).toBe(true);
  });

  it("accepts and ignores agent CLI flags Flint has no use for", () => {
    const o = parseStdioArgs(argv("--stdio", "--max-turns", "5", "--add-dir", "/tmp", "--model", "m"));
    expect(o.model).toBe("m");
  });
});

describe("protocol", () => {
  it("reads the gateway's user envelope, text or blocks", () => {
    expect(userContent({ type: "user", message: { role: "user", content: "hi" } })).toBe("hi");
    expect(userContent({ message: { content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] } })).toBe("a\n\nb");
    const withImage = userContent({ message: { content: [{ type: "text", text: "look" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } }] } });
    expect(withImage[1]).toEqual({ type: "image_url", image_url: { url: "data:image/png;base64,AAA" } });
    expect(userContent({ message: { content: "  " } })).toBeNull();
    expect(parseInputLine("not json")).toBeNull();
  });

  it("writes a reply as text then tool_use blocks, with usage, as the gateway parses it", () => {
    const ev = assistantEvent({
      reply: { content: "Checking.", tool_calls: [{ id: "t1", function: { name: "run_command", arguments: "{\"command\":\"ls\"}" } }] },
      usage: { prompt_tokens: 100, completion_tokens: 7 }, model: "m", sessionId: "s", messageId: "msg_1",
    });
    expect(ev.type).toBe("assistant");
    expect(ev.message.content).toEqual([
      { type: "text", text: "Checking." },
      { type: "tool_use", id: "t1", name: "run_command", input: { command: "ls" } },
    ]);
    expect(ev.message.usage).toMatchObject({ input_tokens: 100, output_tokens: 7 });
    expect(assistantEvent({ reply: { content: "" } })).toBeNull();
  });

  it("cuts a huge tool result so one line stays readable", () => {
    const ev = toolResultEvent({ toolUseId: "t", result: "x".repeat(TOOL_RESULT_MAX_CHARS + 50), sessionId: "s" });
    expect(ev.message.content[0].content.length).toBeLessThan(TOOL_RESULT_MAX_CHARS + 100);
  });

  it("maps Flint's stop reasons to stream-json result subtypes", () => {
    expect(resultSubtype("done")).toBe("success");
    expect(resultSubtype("denied")).toBe("success");
    expect(resultSubtype("budget")).toBe("error_max_budget_usd");
    expect(resultSubtype("stall")).toBe("error_during_execution");
  });
});

describe("result event truncated_at", () => {
  it("resultEvent includes truncated_at when given, null otherwise", () => {
    const ev = resultEvent({
      subtype: "error_max_budget_usd",
      text: "cut short",
      sessionId: "s1",
      durationMs: 100,
      numTurns: 150,
      costUsd: 0,
      promptTokens: 0,
      completionTokens: 0,
      stopReason: "budget",
      truncatedAt: { type: "max_iterations", limit: 150, used: 150 },
    });
    expect(ev.truncated_at).toEqual({ type: "max_iterations", limit: 150, used: 150 });

    const ev2 = resultEvent({
      subtype: "success",
      text: "done",
      sessionId: "s1",
      durationMs: 100,
      numTurns: 1,
      stopReason: "done",
    });
    expect(ev2.truncated_at).toBeNull();
  });

  it("runTurn passes truncated_at from the agent result into the result event", async () => {
    const h = harness(async () => ({
      text: "cut short", stop_reason: "budget", stats: {},
      truncated_at: { type: "max_iterations", limit: 150, used: 150 },
    }));
    h.user("go");
    await new Promise((r) => setTimeout(r, 10));
    const results = h.out.filter((o) => o.type === "result");
    expect(results[0].truncated_at).toEqual({ type: "max_iterations", limit: 150, used: 150 });
  });

  it("runTurn sets truncated_at to null when the result has none", async () => {
    const h = harness(async () => ({ text: "done", stop_reason: "done", stats: {} }));
    h.user("go");
    await new Promise((r) => setTimeout(r, 10));
    const results = h.out.filter((o) => o.type === "result");
    expect(results[0].truncated_at).toBeNull();
  });
});

function harness(run) {
  const out = [];
  let ended = false;
  let interruptedHook = 0;
  const s = createStdioSession({
    write: (o) => out.push(o), run, sessionId: "s1", model: "m",
    onIdleEnd: () => { ended = true; }, onInterrupted: () => { interruptedHook++; },
  });
  const user = (text) => s.line(JSON.stringify({ type: "user", message: { role: "user", content: text } }));
  return { s, out, user, isEnded: () => ended, interruptedHook: () => interruptedHook };
}

describe("turns", () => {
  it("delivers a steer inside the running turn before the next model call, in order", async () => {
    let resume;
    const h = harness(async (_content, { observer }) => {
      observer.onToken("Working ");
      await new Promise((r) => { resume = r; });
      const feedback = observer.onCheckQueue();
      observer.onApiCall();
      observer.onToken("with your change");
      observer.onStreamEnd();
      observer.onReply({ content: `used ${feedback.join(", ")}` }, {});
      return { text: `used ${feedback.join(", ")}`, stop_reason: "done" };
    });
    h.user("long task");
    await tick();
    for (const [id, value] of [["a", "first"], ["b", "second"]]) {
      h.s.line(JSON.stringify({ type: "control_request", request_id: id, request: { subtype: "steer", text: value } }));
    }
    expect(h.out.filter((e) => e.type === "control_response").map((e) => e.response.response.status)).toEqual(["accepted", "accepted"]);
    expect(h.out.some((e) => e.type === "result")).toBe(false);
    resume();
    await tick();
    expect(h.out.filter((e) => e.type === "steer_status")).toEqual([
      { type: "steer_status", request_id: "a", status: "delivered", session_id: "s1" },
      { type: "steer_status", request_id: "b", status: "delivered", session_id: "s1" },
    ]);
    expect(h.out.filter((e) => e.type === "text_delta").map((e) => e.delta).join("")).toBe("Working with your change");
    expect(h.out.at(-1)).toMatchObject({ type: "result", result: "used first, second" });
  });

  it("reports a steer that missed the final queue check, and rejects unknown controls", async () => {
    let resume;
    const h = harness(async () => new Promise((r) => { resume = r; }));
    h.user("task");
    await tick();
    h.s.line(JSON.stringify({ type: "control_request", request_id: "late", request: { subtype: "steer", text: "change" } }));
    h.s.line(JSON.stringify({ type: "control_request", request_id: "bad", request: { subtype: "other" } }));
    resume({ text: "done", stop_reason: "done" });
    await tick();
    expect(h.out).toContainEqual({ type: "steer_status", request_id: "late", status: "too_late", session_id: "s1" });
    expect(h.out).toContainEqual({ type: "control_response", response: { subtype: "error", request_id: "bad", error: "unsupported_control_request" } });
    h.s.line(JSON.stringify({ type: "control_request", request_id: "idle", request: { subtype: "steer", text: "new work" } }));
    expect(h.out.at(-1).response.error).toBe("too_late");
  });

  it("does not report delivery when a queue check is followed by an early exit", async () => {
    let resume;
    const h = harness(async (_content, { observer }) => {
      await new Promise((r) => { resume = r; });
      expect(observer.onCheckQueue()).toEqual(["new direction"]);
      return { text: "limit reached", stop_reason: "budget" };
    });
    h.user("task");
    await tick();
    h.s.line(JSON.stringify({ type: "control_request", request_id: "r", request: { subtype: "steer", text: "new direction" } }));
    resume();
    await tick();
    expect(h.out.filter((e) => e.type === "steer_status").map((e) => e.status)).toEqual(["too_late"]);
  });

  it("keeps thought text out of deltas even when tags split across tokens", () => {
    const out = [];
    const stream = visibleTextStream((s) => out.push(s));
    for (const token of ["hello <thi", "nking>secret", " thoughts</thin", "king> world"]) stream.token(token);
    stream.end();
    expect(out.join("")).toBe("hello  world");
  });

  it("runs turns one at a time in order, each ending with one result", async () => {
    const seen = [];
    const h = harness(async (content) => { seen.push(content); await tick(); return { text: `re: ${content}`, stop_reason: "done", stats: { cost: 0.01, promptTokens: 5, completionTokens: 2 } }; });
    h.user("one");
    h.user("two");
    await new Promise((r) => setTimeout(r, 20));
    expect(seen).toEqual(["one", "two"]);
    const results = h.out.filter((o) => o.type === "result");
    expect(results.map((r) => r.result)).toEqual(["re: one", "re: two"]);
    expect(results[0]).toMatchObject({ subtype: "success", is_error: false, session_id: "s1", total_cost_usd: 0.01, usage: { input_tokens: 5, output_tokens: 2 } });
  });

  it("streams replies and tool results while the turn runs, pairing each result with its call", async () => {
    const h = harness(async (content, { observer }) => {
      observer.onReply({ content: "", tool_calls: [
        { id: "a", function: { name: "read_file", arguments: "{}" } },
        { id: "b", function: { name: "read_file", arguments: "{}" } },
      ] }, {});
      observer.onToolResult("read_file", "first", false);
      observer.onToolResult("read_file", "Error: no such file", false);
      observer.onReply({ content: "done" }, {});
      return { text: "done", stop_reason: "done" };
    });
    h.user("go");
    await new Promise((r) => setTimeout(r, 10));
    expect(h.out.map((o) => o.type)).toEqual(["assistant", "user", "user", "assistant", "result"]);
    expect(h.out[1].message.content[0]).toMatchObject({ tool_use_id: "a", is_error: false });
    expect(h.out[2].message.content[0]).toMatchObject({ tool_use_id: "b", is_error: true });
    expect(h.out[4].num_turns).toBe(2);
  });

  it("two calls of one tool running at once each report their own duration and args", async () => {
    // The timings used to be kept under the tool's NAME: the second start
    // overwrote the first, so one result got the other call's args and the
    // last one got duration 0 and no args at all.
    const now = Date.now();
    const h = harness(async (content, { observer }) => {
      observer.onReply({ content: "", tool_calls: [
        { id: "a", function: { name: "read_file", arguments: '{"path":"a.txt"}' } },
        { id: "b", function: { name: "read_file", arguments: '{"path":"b.txt"}' } },
      ] }, {});
      observer.onToolStart("read_file", { path: "a.txt" }, { startedAt: now - 5000, id: "a" });
      observer.onToolStart("read_file", { path: "b.txt" }, { startedAt: now - 1000, id: "b" });
      // b, started last, ends first.
      observer.onToolResult("read_file", "B", false, { id: "b" });
      observer.onToolResult("read_file", "A", false, { id: "a" });
      return { text: "done", stop_reason: "done" };
    });
    h.user("go");
    await new Promise((r) => setTimeout(r, 10));
    const [first, second] = h.out.filter((o) => o.type === "user");
    expect(first.message.content[0]).toMatchObject({ tool_use_id: "b", content: "B" });
    expect(first.args).toEqual({ path: "b.txt" });
    expect(first.duration_ms).toBeGreaterThanOrEqual(1000);
    expect(first.duration_ms).toBeLessThan(4000);
    expect(second.message.content[0]).toMatchObject({ tool_use_id: "a", content: "A" });
    expect(second.args).toEqual({ path: "a.txt" });
    expect(second.duration_ms).toBeGreaterThanOrEqual(5000);
    // The start line names its call too, so a host pairs start and result.
    const starts = h.out.filter((o) => o.type === "tool_start");
    expect(starts.map((o) => [o.tool_use_id, o.args.path])).toEqual([["a", "a.txt"], ["b", "b.txt"]]);
  });

  it("a result reported under the tool's resolved name still answers the call the model made", async () => {
    // The model calls `bash`; the permission layer resolves it to run_command
    // and the result is reported under that name. Paired by name, the result
    // found no pending call and went out under an invented id.
    const h = harness(async (content, { observer }) => {
      observer.onReply({ content: "", tool_calls: [{ id: "c1", function: { name: "bash", arguments: "{}" } }] }, {});
      observer.onToolStart("run_command", { command: "ls" }, { startedAt: Date.now(), id: "c1" });
      observer.onToolResult("run_command", "ok", false, { id: "c1" });
      return { text: "done", stop_reason: "done" };
    });
    h.user("go");
    await new Promise((r) => setTimeout(r, 10));
    const res = h.out.find((o) => o.type === "user");
    expect(res.message.content[0].tool_use_id).toBe("c1");
    expect(res.args).toEqual({ command: "ls" });
  });

  it("an interrupt stops the running turn, which ends as error_during_execution, and the session goes on", async () => {
    const h = harness((content, { signal }) => new Promise((resolve, reject) => {
      if (content === "after") return resolve({ text: "still here", stop_reason: "done" });
      signal.addEventListener("abort", () => { const e = new Error("aborted"); e.name = "AbortError"; reject(e); });
    }));
    h.user("long");
    await tick();
    h.s.line(JSON.stringify({ type: "control_request", request_id: "r1", request: { subtype: "interrupt" } }));
    h.user("after");
    await new Promise((r) => setTimeout(r, 10));
    expect(h.out[0]).toMatchObject({ type: "control_response", response: { subtype: "success", request_id: "r1" } });
    const results = h.out.filter((o) => o.type === "result");
    expect(results[0]).toMatchObject({ subtype: "error_during_execution", is_error: true, stop_reason: "interrupted" });
    expect(results[1]).toMatchObject({ subtype: "success", result: "still here" });
    expect(h.interruptedHook()).toBe(1);
  });

  it("answers an interrupt with nothing running, so a host waiting on it does not hang", () => {
    const h = harness(async () => ({ text: "", stop_reason: "done" }));
    h.s.line(JSON.stringify({ type: "control_request", request_id: "r9", request: { subtype: "interrupt" } }));
    expect(h.out).toEqual([{ type: "control_response", response: { subtype: "success", request_id: "r9", response: {} } }]);
  });

  it("a turn that throws ends with an error result, not a dead process", async () => {
    const h = harness(async () => { throw new Error("provider down"); });
    h.user("x");
    await new Promise((r) => setTimeout(r, 10));
    expect(h.out.at(-1)).toMatchObject({ type: "result", subtype: "error_during_execution", result: "Error: provider down" });
  });

  it("stdin closing waits for the running turn, then ends", async () => {
    let release;
    const h = harness(() => new Promise((r) => { release = () => r({ text: "ok", stop_reason: "done" }); }));
    h.user("x");
    h.s.end();
    await tick();
    expect(h.isEnded()).toBe(false);
    release();
    await new Promise((r) => setTimeout(r, 10));
    expect(h.out.at(-1).type).toBe("result");
    expect(h.isEnded()).toBe(true);
  });
});

describe("the host's instructions", () => {
  it("reads CLAUDE.md from the folder and its parents, outermost first, then the prompt flags", () => {
    const root = mkdtempSync(path.join(tmpdir(), "flint-claudemd-"));
    const agent = path.join(root, "agents", "alex");
    mkdirSync(agent, { recursive: true });
    writeFileSync(path.join(root, "agents", "CLAUDE.md"), "Shared rules.");
    writeFileSync(path.join(agent, "CLAUDE.md"), "You are Alex.");
    const chain = claudeMdChain(agent);
    expect(chain.slice(-2)).toEqual([path.join(root, "agents", "CLAUDE.md"), path.join(agent, "CLAUDE.md")]);
    const prompt = hostPromptFrom({ systemPrompt: "From the gateway.", appendSystemPrompt: "Last word." }, { cwd: agent });
    expect(prompt).toMatch(/take precedence/);
    const order = ["From the gateway.", "Shared rules.", "You are Alex.", "Last word."].map((t) => prompt.indexOf(t));
    expect(order.every((i, k) => i >= 0 && (k === 0 || i > order[k - 1]))).toBe(true);
  });

  it("finds .mcp.json in the agent's folder unless --mcp-config names another", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "flint-mcpjson-"));
    expect(mcpConfigPath({}, dir)).toBeNull();
    writeFileSync(path.join(dir, ".mcp.json"), "{}");
    expect(mcpConfigPath({}, dir)).toBe(path.join(dir, ".mcp.json"));
    expect(mcpConfigPath({ mcpConfig: "other.json" }, dir)).toBe(path.join(dir, "other.json"));
  });
});

describe(".mcp.json servers", () => {
  it("keeps headers, command, args and env, as agent configs use them", () => {
    const servers = mcpJsonServers({ mcpServers: {
      hitl: { type: "http", url: "http://127.0.0.1:8790/", headers: { Authorization: "Bearer x" } },
      planner: { type: "stdio", command: "/opt/venv/bin/python", args: ["/opt/mcp planner.py"], env: { A: "1" } },
      bare: { command: "npx", args: ["some-server"] },
    } });
    expect(servers[0]).toMatchObject({ name: "hitl", transport: "http", headers: { Authorization: "Bearer x" } });
    expect(servers[1]).toMatchObject({ name: "planner", transport: "stdio", command: "/opt/venv/bin/python", args: ["/opt/mcp planner.py"], env: { A: "1" } });
    expect(servers[2]).toMatchObject({ transport: "stdio", command: "npx", fromFile: true });
  });

  it("merges with the MCP_SERVERS string", () => {
    const merged = [...parseServerConfig("a|http|http://x/mcp"), ...mcpJsonServers({ mcpServers: { b: { url: "http://y/mcp" } } })];
    expect(parseServerConfig(merged).map((s) => s.name)).toEqual(["a", "b"]);
  });
});

describe("result event provider_error", () => {
  it("carries the provider's definite verdict for the turn, and null otherwise", async () => {
    const h = harness(async (content) => content === "bad"
      ? { text: "API 404", stop_reason: "model-not-found", providerError: { status: 404, kind: "model-not-found" } }
      : { text: "ok", stop_reason: "done" });
    h.user("bad");
    await tick();
    h.user("fine");
    await new Promise((r) => setTimeout(r, 20));
    const results = h.out.filter((o) => o.type === "result");
    expect(results[0]).toMatchObject({ subtype: "error_during_execution", provider_error: { status: 404, kind: "model-not-found" } });
    expect(results[1].provider_error).toBeNull();
  });
});
