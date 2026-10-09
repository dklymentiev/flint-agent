# stdio event stream — what the host actually receives

## How the stdio mode works

The stdio mode (`src/stdio/`) runs Flint as a long-lived subprocess driven over
stream-json (one JSON object per line on stdin and stdout). A host sends `user`
lines on stdin; Flint replies with one JSON object per line on stdout.

The host can subscribe to a **turn observer** (`setTurnObserver` in
`src/message-handler.js`). The stdio session (`src/stdio/session.js`) installs
one observer and translates its callbacks into protocol events (`src/stdio/protocol.js`).

## What the host receives — observed from a real run

A mock OpenAI-compatible provider was run locally. The provider first replied
with a partial text chunk + a `run_command` tool call, then after the tool
returned, a final text answer. The exact stdout lines, in order:

```
{"type":"system","subtype":"init", ...}           # session init
{"type":"assistant","message":{...}}              # full reply: text + tool_use blocks
{"type":"user","message":{...}}                   # tool_result
{"type":"assistant","message":{...}}              # final text answer
{"type":"result","subtype":"success", ...}        # turn result
```

### What is present

| Event | Fields |
|---|---|
| `system/init` | session_id, cwd, model, tools, mcp_servers, permissionMode, version |
| `assistant` | message with text + tool_use blocks (id, name, input args) |
| `user` (tool_result) | tool_use_id, content, is_error |
| `result` | subtype (success/error_during_execution/error_max_budget_usd), text, session_id, duration_ms, num_turns, total_cost_usd, usage, stop_reason |

### What is missing

1. **No tool-start event.** The host learns a tool was called only when its
   result arrives. A long-running tool gives no signal that it has begun, so a
   node cannot mark the turn as active at the moment a tool starts.

2. **No tool name in the result event.** The `user` envelope carries `tool_use_id`
   but not the tool name. The host must correlate the id back through the
   `assistant` event that contained the `tool_use` block — fine for one tool,
   awkward when the same tool is called multiple times in one reply.

3. **No tool duration.** Neither the start nor the end of a tool call carries a
   timestamp or duration. The turn-level `result` has `duration_ms` for the
   whole turn, but the per-tool cost is invisible.

4. **No streaming text.** The `assistant` event is emitted only after the model
   finishes its entire reply. Tokens arrive at `onToken` inside
   `message-handler.js` but are never forwarded to the turn observer, so the
   host cannot show incremental text as it streams.

5. **No per-tool-args in the result.** The result envelope has the result text
   but not the arguments that produced it; the host must pair it with the
   request side of the `assistant` block.

## Where the code leaves the gaps

In `src/stdio/session.js`, `createStdioSession` builds an observer object
with only two callbacks:

```js
const observer = {
  onReply(reply, usage) { /* → assistant event */ },
  onToolResult(name, result, denied) { /* → tool_result event */ },
};
```

In `src/message-handler.js`, `runAgent` is called with callbacks that include
`onToolStart`, `onToken`, and `onStreamEnd` — but only `onReply` (via
`onApiResponse`) and `onToolResult` are forwarded to the observer through
`tellObserver(...)`. The other three are handled by the console UI only:

- `onToolStart` updates the activity row and tool-activity log, but does **not**
  call `tellObserver`.
- `onToken` accumulates streaming text into the console but does **not** call
  `tellObserver`.
- `onStreamEnd` flushes the buffer but does **not** call `tellObserver`.

## Verdict

The stdio protocol carries a **complete but post-hoc** event stream: every tool
call and its result, every model reply, and a final turn result — but nothing
while a tool is running or as text streams. A node that needs to show "tool X
started", "tool X finished (duration, result)", and incremental text must
either wait for the `tool_result` envelope (and correlate ids) or add its own
instrumentation. The protocol itself is extensible (it is one JSON object per
line, and new event types are additive), so closing the gaps is a matter of
forwarding three more callbacks and emitting a couple of new event types.
