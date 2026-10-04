# Context swap (design)

Status: design, 2026-10-02. Target: the release after 1.10.0. Nothing here is
built yet.

## Problem

Everything a tool returns stays in the conversation, and the whole
conversation is sent again on every model call. A research turn that reads
pages through Screenbox keeps every page:

| Session 2026-10-02T14-11-21 (Dots research) | |
|---|---|
| a turn of 23 tool calls | 1,759k input tokens |
| a turn of 6 tool calls | 625k input tokens |
| context at the end of the session | 91k tokens |

Prompt caching makes the repeated part cheaper (about 99% cached since
5f18597), not free, and it does nothing for the window: a night of reading a
site would outgrow any window.

Today's only relief is `compressContext` (src/agent/compression.js). It starts
when the estimated context passes `compressThreshold()`, half the model's
window up to 128k, and then turns old tool results into one-line summaries.
On a 1M-window model that is 128k, so a session like the one above is never
compressed; and when it is, the content is gone: the 2026-09-26 run with an
early threshold "never edited anything, it re-read".

## Goal

Context stays under a set size however much the agent reads, and nothing it
read is lost: what leaves the context is on disk, with an address, and the
agent knows where to look. A virtual-memory swap for the conversation.

## Design

### Budget

Two numbers, in config:

- `swapBudget`: how much of the context tool results may take (16k tokens at
  spend level normal). Above it, the oldest results are swapped out until
  they take `swapLowWater` (default 60% of the budget).
- `swapResultMax`: the largest tool result kept whole as it arrives. It is the
  budget in bytes, not a number of its own (see "New is whole" below). Only a
  result bigger than everything the results may take is swapped at once.

The budget is for what can be evicted. Stubs and results under 1 KB stay
whatever happens, so they are not counted against it.

Swapping down to a low-water mark, not to just under the budget, is for the
prompt cache: each eviction rewrites history from the evicted message on, so
evictions should be rare and in batches, not one per call.

### What is swapped

Tool results only. Never the operator's messages, the agent's answers, tool
calls (their arguments are the record of what was done), or the results of the
last call (the model has not read them yet). Results already small (under
1 KB) are not worth a stub and stay.

Eviction order: oldest first, by the turn and call that produced them.

### What stays in the context

A one-line stub in place of the result, and for a result swapped on arrival,
its head and outline:

```
[swap #37 · page · help.openai.com/en/articles/20001554-manage-dots · 11.2 KB · "Manage dots in ChatGPT workspaces" · turn 12 · swap_read 37]
```

On arrival the model gets the stub plus the first 2 KB and the headings (lines
starting with `#`, or HTML h1-h3 for pages), so it can decide whether to read
on. The stub is built from the entry alone, so the same entry always gives the
same bytes (cache).

### On disk

In the session's folder, next to its chat log:

```
sessions/<session>/swap/
  index.jsonl
  t012/037-page-help-openai-com-manage-dots.md
  t012/038-file-src-agent-agent-js.txt
```

`index.jsonl`, one line per entry, appended as entries are made:

```json
{"id":37,"t":"2026-10-02T16:13:04Z","turn":12,"call":4,"tool":"mcp_screenbox_desktop_chrome",
 "kind":"page","source":"https://help.openai.com/en/articles/20001554-manage-dots",
 "title":"Manage dots in ChatGPT workspaces","bytes":11468,"file":"t012/037-page-help-openai-com-manage-dots.md"}
```

`kind` is page, file, command, search or other, from the tool. `source` is
the URL, path or command. `title` is the first heading or line.

A thousand entries are fine: the agent reads the index, never the folder.

### Tools

- `swap_list({ turn?, since?, source?, text?, limit? })`: index entries,
  newest first, filtered by turn, time ("1h"), source substring or a word in
  the title. One line each, as the stub.
- `swap_read({ id, offset?, limit? })`: the entry's text, whole or a range of
  lines, with the stub as the first line.

Searching the content is `search_in_files` on `sessions/<session>/swap/`; the
system prompt says so in one line.

A swap_read result is itself swappable, so reading back does not undo the
budget.

### Prompt

One short section in system.md: what a swap stub is, that the index lists
everything read in this session, and to search or read back rather than fetch
again. Above the dynamic boundary, so it does not move.

### Lifecycle

- Swap belongs to the session: kept with it, survives `/resume` and restarts
  (the stubs in the history point at files that are still there), removed
  with the session.
- Child agents (spawn_agent) have their own data folder since 8d7df49, so their
  own swap.
- The stdio mode works the same; its data folder is the agent's.

### With today's compression

`compressContext` keeps its fact extraction, its side-effect logging and
turning old screenshots into their text. With swap on it does not touch tool
results: they are swap's to move. With swap off (`FLINT_SWAP=0`) it cuts them
as it always did, and so does the one-line pass before it in the loop.

## Config

| Variable | Default |
|---|---|
| `FLINT_SWAP` | `1` (`0` turns it off: today's behaviour) |
| `FLINT_SWAP_RESULT_MAX` | the budget in bytes (4 x `FLINT_SWAP_BUDGET`) |
| `FLINT_SWAP_BUDGET` | by spend level: 8000, 16000 or 64000 tokens |
| `FLINT_SWAP_LOW_WATER` | `0.6` |

## Module

`src/agent/swap.js`, pure where it can be, so the rules are testable alone:

| Export | Does |
|---|---|
| `swapEnabled(env)` | `FLINT_SWAP` is not `0` |
| `swapSettings(env)` | `{ resultMax, budgetTokens, lowWater, minBytes, headBytes }` from the variables below |
| `kindOf(tool)` | page, file, command, search or other |
| `sourceOf(tool, args)` | URL, path or command, from the call's arguments |
| `titleOf(text)` | first heading, else first non-empty line, at most 100 characters |
| `outlineOf(text, max)` | up to `max` heading lines (markdown `#`, HTML h1-h3) |
| `stubFor(entry)` | the one-line stub, from the entry only |
| `arrivalView(entry, text, headBytes)` | stub, the first `headBytes` of the text, the outline |
| `createSwapStore(dir)` | `put(record)`, `get(id)`, `list(filter)`, `read(id, {offset, limit})`; ids continue from an existing index |
| `planEviction(messages, opts)` | indices of tool results to swap out, oldest first, or none |
| `applySwap(messages, store, opts)` | swaps out what `planEviction` names; returns how many |

`src/tools/swap-tools.js`: `swap_list`, `swap_read` over the current
session's store.

Wiring in `src/agent/agent.js`: a result bigger than `resultMax` is put in the
store as it arrives and its `arrivalView` goes into the history; before each
model call `applySwap` runs on the history.

## Acceptance

Each criterion is a test; the test names say which.

| # | Criterion | Test |
|---|---|---|
| A1 | **Bounded.** 30 tool calls of 11 KB each in one turn: after every call, the tool results in the payload take at most `budgetTokens` plus the results of the latest call. Without swap the same run exceeds it. | `tests/integration/swap-loop.test.js` |
| A2 | **Nothing lost.** Every one of the 30 results is in the index, and `swap_read` returns each one byte for byte. | `swap-loop.test.js`, `swap-store.test.js` |
| A3 | **Cache-friendly.** Between consecutive calls that swap nothing, the earlier payload is a prefix of the later one. Swapping happens in batches: in the 30-call run, fewer than one call in three rewrites earlier messages. | `swap-loop.test.js` |
| A4 | **Off is off.** With `FLINT_SWAP=0` the payloads are identical to a run of the same script with swap absent, and no swap folder is written. | `swap-loop.test.js` |
| A5 | **Survives a restart.** A store opened again on the same folder lists the old entries, reads them, and gives the next entry the next id. | `swap-store.test.js` |
| A6 | **Rules.** Never swapped: the operator's and the agent's messages, tool calls, results of the latest call, results under `minBytes`, results already swapped. Oldest go first, down to `lowWater` of the budget. | `swap-policy.test.js` |
| A7 | **Stubs are stable.** The same entry gives the same stub bytes; the stub names id, kind, source, size, title, turn and how to read it back. | `swap-policy.test.js` |
| A8 | **Arrival.** A result over `resultMax` reaches the history as its arrival view (stub, head, outline) and the whole text is in the store. | `swap-policy.test.js`, `swap-loop.test.js` |
| A11 | **New is whole.** With swap awake and the settings of every spend level, a result that fits the budget is in the next payload in full. | `swap-policy.test.js`, `swap-loop.test.js` |
| A12 | **Stubs cost nothing.** A history of 475 stubs and one 5 KB result from an earlier call of the current turn evicts nothing. | `swap-policy.test.js` |
| A9 | **Tools.** `swap_list` filters by turn, time, source and title words; `swap_read` reads a range of lines; an unknown id says so. | `swap-tools.test.js` |
| A10 | **Live.** A real session that reads 30 pages through Screenbox: context under budget, every page indexed, a question about page 3 answered with `swap_read`, input tokens for the turn at least 3x lower than the 1,759k measured above. | manual, numbers recorded in the PR |

## When swap is on (revised after the live runs)

The live comparison of 2026-10-02 (30 pages through Screenbox, swap on
against off) gave no saving: 38k against 36k tokens a call. A constant 22k
of every call is the system prompt and the tool schemas, Screenbox caps a
page at 15,000 characters, and the existing compression had already cut
the off-run's old results to summaries. With swap always on, the agent
read pages back and made more calls (88 against 71).

So swap is a safety net, not a mode:

- It is dormant until the context reaches `swapFrom`, by default 75% of the
  compression threshold (`compressThreshold()`: half the model's window, at
  most 128k; 64k when the window is unknown), so 96k on a 1M-window model.
  `FLINT_SWAP_FROM` sets it in tokens.
- At or above it, both rules work: big results are swapped as they arrive,
  and old results are swapped out down to the low-water mark.
- Below it nothing is touched, so a normal session sends what it sent
  before swap existed.
- The compression threshold stays above swap's. With swap on, nothing at
  that threshold cuts a tool result (see "Compression does not cut what swap
  can keep").

## Conversation swap

Compression and tool-result swap touch tool results only. The operator's
messages and the agent's answers are never shortened, so ten hours of
talking grows the context with every exchange until the model's window
refuses the call (no handling for that exists).

The same swap, for the conversation:

- At the start of a turn, when the context is at or above `convHigh`
  (default: the compression threshold, so half the window and at most
  128k at level normal, 64k when the window is unknown;
  `FLINT_SWAP_CONV_HIGH`), the oldest whole turns, about
  `convChunk` tokens of them (default a third of `convHigh`), are moved to
  the swap as one entry of kind `conversation`: a transcript of the turns.
- In their place goes one line, after the system message and the earlier
  conversation stubs, so the top of the history reads as a table of
  contents of the day and the bottom stays whole:

  ```
  [conv #c3 · turns 12-19 · 09:40-10:30 · 98k · "Dots research: docs 01-03 written, Astra/Sol resolved" · swap_read 41]
  ```

- What the line says comes from one model call per chunk (two sentences,
  `source: "swap"` in the usage), so a chunk of 100k tokens costs one short
  call. If the call fails, the line lists the first words of each
  operator message in the chunk instead.
- Never moved: the system message, the current turn, the last
  `convKeepTurns` turns (default 4), stubs already there.
- Turns are cut at their boundaries: a turn is the operator's message and
  everything up to the next one.

## Acceptance, second part

| # | Criterion | Test |
|---|---|---|
| B1 | **Dormant below the threshold.** With the context under `swapFrom`, no result is swapped on arrival or evicted: payloads are what they are with swap off. | `swap-policy.test.js`, `swap-loop.test.js` |
| B2 | **Engages above it.** Over `swapFrom`, arrival swap and eviction work as in A1-A8. | `swap-loop.test.js` |
| B3 | **Defaults follow the model.** `swapFrom` is 75% of the compression threshold: 96k for a 1M window, 48k for an unknown one; `FLINT_SWAP_FROM` overrides. | `swap-policy.test.js` |
| C1 | **Plan.** Under `convHigh` nothing moves. Over it, the oldest whole turns of about `convChunk` tokens are chosen; never the system message, the latest `convKeepTurns` turns, or stubs. | `swap-conversation.test.js` |
| C2 | **Stub and store.** The chosen turns become one `conversation` entry holding their transcript, and one line in their place, after the system message and earlier stubs; tool calls and their results leave together. | `swap-conversation.test.js` |
| C3 | **The line says what it was.** The summary from the model goes in the line; when the call fails, the first words of the operator's messages do. | `swap-conversation.test.js` |
| C4 | **A long talk stays under the window.** A scripted session of 60 turns of 6k tokens each, `convHigh` 100k: before every turn the context is under `convHigh` + one turn, all turns are in the store or whole, and `swap_read` of the first entry gives turn 1's text. | `swap-conversation.test.js` |

## Not in this step

- An overnight crawl: batches of pages handed to child agents that return
  notes only. It builds on swap and comes after it.
- Merging old conversation lines into a line a level up when there are
  hundreds of them.
- Summaries written by a model at swap time (a second call per page). The
  head and outline come free; a summary can be added if the agent proves to
  need it.
- Swapping the agent's own long answers.

## New is whole, old is swapped (2026-10-03)

The rule, in the owner's words: swap takes the old messages, new messages
arrive complete.

What broke it. The operator pointed a long session (turn 52, 986 messages) at
a 5.2 KB task file. The agent called `read_file`, answered that it had read
the file, then said 3.7 KB were still unread and described sections the file
does not have. Two causes, both in the thresholds:

- **A fresh result was cut on arrival.** `resultMax` was 4 KB at level normal,
  a number chosen for a run of web pages. The file arrived as a stub, its
  first 1500 bytes and the outline of its headings; the agent knew the start,
  knew the section names, and filled in the rest.
- **Stubs used up the budget.** `planEviction` added up every tool result. In
  that session 475 of 477 results were under 1 KB, most of them stubs, and
  took 14k of the 16k budget by themselves. Any fresh result tipped the sum
  over, and since stubs cannot be evicted the low-water mark was out of
  reach: everything older than the latest call went, every call.

What changed.

- `resultMax` follows the budget: a result is swapped on arrival only when it
  alone is bigger than the whole budget (32, 64 or 256 KB by spend level).
  Room for it is made by evicting older results, oldest first.
- Only results that can be evicted count against the budget.

The 30-page run stays bounded as before (A1 to A3): a page now arrives whole,
is read once, and leaves at the next eviction.

Not changed in that step: in the same session the agent's own messages were
96k of about 123k tokens of context and tool results 15k. Swap worked on the
smaller part, and conversation swap started at 300k on a 1M-window model.
The next section is what that cost.

## Compression does not cut what swap can keep (2026-10-04)

What was found. Past the compression threshold a file read one turn earlier
was cut to its first eight and last three lines, and anything older to one
line, with nothing put in swap. Measured on a session of about 192k tokens as
the provider counts them (about 150k by the estimate used here): a 16 KB
result was 16,177 characters when it arrived and 439 at the next turn's
second call. The agent answered right and had to read the file again, one to
seven more calls. At about 158k the same question was answered from the
context.

Why. The compression threshold counts the whole context, and the weight of a
long session is the conversation. Swap took tool results only, and the
conversation's own swap started at 300k. So between 128k and 300k the context
was over the threshold whatever swap did, and compression cut tool results
on every turn of two or more calls, though swap's budget for them was a
quarter full. A second pass in the loop did the same from an earlier point,
because it went by the provider's count and not by the estimate.

Why no test saw it. Every swap test kept the compression threshold at ten
million tokens, "out of the way".

What changed.

- With swap on, neither pass touches a tool result. A result is whole, or it
  is in swap with a stub; there is no third state.
- The conversation's swap starts at the compression threshold. The context is
  bounded by the two budgets together: tool results by swap's, the talk by
  the conversation's.
- One measure for all of it: the estimate of the messages, characters / 4.
  The provider's count is higher (it has the system prompt and the tool
  schemas in it, and tokenises denser), by about a third on a large session.
  The one-line pass that still goes by the provider's count runs only with
  swap off.

| # | Criterion | Test |
|---|---|---|
| D1 | **Whole or in swap.** With the estimate over the compression threshold on the weight of the conversation, every tool result in every payload is whole or a swap stub, and what left is in the store to the byte. | `swap-loop.test.js` |
| D2 | **Compression leaves results alone when asked.** `keepToolResults` keeps a result of the previous call and an older one as they are; an old screenshot still becomes its text. | `compression.test.js` |
| D3 | **The two thresholds are one.** `convSettings().high` equals the compression threshold at every level and for every window. | `spend.test.js` |
| D4 | **Live.** A 16 KB file read two turns ago, after 650 KB of conversation, is answered about without going back to the file. Before: 0 of 3 runs, the context at 215k and growing. After: 3 of 3, the context at 159k. | a live session against a real model; not part of the test suites |
