# Spend modes (design)

Status: design, 2026-10-02.

## Why

Every token-saving rule in Flint has its own variable and its own default,
and the defaults were set for cheap, small-window runs: MCP tools offered
through a search past 30 of them, old tool results cut to one-line
summaries at half the window (at most 128k), swap waking at 75% of that.
Someone trying Flint with a capable model meets an agent that summarises
what it read and searches for tools it was given, and may take it for
unfinished. Someone paying per token wants the opposite.

One switch sets them together, the way the care level (`/careful`) sets
which tools ask.

## Modes

| | economy | normal (default) | generous |
|---|---|---|---|
| MCP tools offered whole (above: through `tool_search`) | 10 | 30 | 200 |
| The compression threshold: with swap off, old tool results are cut from here; with swap on (the default) they are swap's, and this is where old screenshots turn into text and facts are extracted | a quarter of the window, at most 64k (32k unknown) | half the window, at most 128k (64k unknown) | 80% of the window, no cap (200k unknown) |
| Swap wakes at (share of the compression threshold) | 50% | 75% | 90% |
| A result bigger than this goes to swap on arrival (when awake): the whole budget of the next row, in bytes | 32 KB | 64 KB | 256 KB |
| Tool results kept in context once swap is awake | 8k tokens | 16k tokens | 64k tokens |
| Head kept of a swapped result | 1 KB | 1.5 KB | 4 KB |
| Conversation swap starts at | the compression threshold | the compression threshold | the compression threshold |
| Token-saving advice in the system prompt | yes | no | no |

Money limits are not part of a mode: `AGENT_MAX_COST` and
`AGENT_SESSION_BUDGET` stay as set (unlimited by default).

The economy advice is a short section: prefer `search_in_files`, `glob` and
reads with offset/limit over whole files; read a page once and note what
matters; make independent calls in one response; use `swap_read` rather than
fetching again. It is not given in the other modes: there it would make the
agent hold back for no reason.

## Choosing and showing

- `/spend` shows the mode and what it sets; `/spend economy|normal|generous`
  changes it at once (the next model call uses it) and saves it.
- Saved in `spend.json` in the data folder (`FLINT_DATA_DIR` or `~/.flint`).
  `FLINT_SPEND` in the environment wins over the saved choice.
- The footer shows it next to the care level: `spend: normal`.
- A variable for a single setting (`FLINT_MCP_INLINE_MAX`,
  `COMPRESS_AFTER_TOKENS`, `FLINT_SWAP_*`) still wins over the mode, so
  existing setups keep working.

## Module

`src/spend.js`:

| Export | Does |
|---|---|
| `SPEND_LEVELS` | the table above, as data |
| `getSpendLevel()` | env `FLINT_SPEND`, else saved, else `normal`; an unknown name reads as `normal` |
| `setSpendLevel(name)` | validates and saves |
| `spendSettings(level?)` | the row values for a level |

Readers: `intent.js` (MCP inline limit), `compression.js`
(`compressThreshold`), `swap.js` (`swapSettings`, `swapFromTokens`,
`convSettings`), `system-prompt.js` (economy advice), `LiveZone.js` (footer),
`commands.js` (`/spend`).

## Acceptance

| # | Criterion | Test |
|---|---|---|
| S1 | Default is normal and gives today's values exactly. | `tests/unit/spend.test.js` |
| S2 | Each level gives its row: MCP inline limit, compression threshold for a 1M, 200k and unknown window, swap settings, conversation settings. | `spend.test.js` |
| S3 | `FLINT_SPEND` wins over the saved level; a single-setting variable wins over both. | `spend.test.js` |
| S4 | `/spend generous` saves, survives a new process, and changes the next call's tool list (an MCP server of 40 tools offered whole). | `spend.test.js`, `tests/integration/spend-modes.test.js` |
| S5 | The economy advice is in the system prompt in economy only. | `spend-modes.test.js` |
| S6 | The footer shows `spend: <level>`; `/spend` with no argument shows the level and its values. | `spend.test.js` |
