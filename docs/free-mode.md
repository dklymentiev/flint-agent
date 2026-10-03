# Free mode (design)

Status: design, 2026-10-02.

Run Flint on OpenRouter's free models without choosing one by hand: Flint
lists the free models that can call tools, with their current speed and
uptime, picks the best, and keeps two fallbacks from other providers.

## Facts it is built on (measured 2026-10-02)

- `GET /api/v1/models`: 22 zero-priced models, 17 with the `:free` suffix;
  five free ones have no suffix (`stealth/space-bunny-alpha` among them). So
  free means a zero prompt and completion price, not a name.
- `GET /api/v1/models/<id>/endpoints`: per provider, status, uptime (5 min,
  30 min, 1 day), latency percentiles (ms) and throughput percentiles (tok/s).
  No completion is made, no quota spent.
- `GET /api/v1/key`: `is_free_tier` true means 50 free requests a day; false
  (after a one-time $10) means 1,000.
- Free models fail upstream often (rate-limited at the provider); an agent
  turn is 6-150 calls.

## Behaviour

- `/model free` opens a pick list of the free models with tool calling and
  text output, best first:

  ```
  Free models · OpenRouter · last 30 min · your limit: 1000 requests/day
      Model                                   Window  Speed     First token  Uptime
    > nvidia/nemotron-3-super-120b-a12b:free  262k    70 tok/s  1.0 s        99.8%
      stealth/space-bunny-alpha               1M      62 tok/s  1.6 s        99.9%  stealth: prompts may be logged
  ```

  Best first: models with uptime of at least 90% (or no data) before the
  rest, then by speed, then by first-token time. Enter takes the model and
  the next two from other vendors as fallbacks.
- `/model free auto` takes the best without the list.
- With a free chain set, requests for the main model carry
  `models: [primary, fallback1, fallback2]`; OpenRouter answers from the
  first one that works. When the answer came from another model than the
  primary, one line says so (once per change of serving model).
- The footer shows `free 37/1000` (requests made today with a free model /
  the daily limit), counted locally per day.
- A 402 while on free models says that a balance below zero blocks free
  models too, and where to top up.
- Choosing any other model with `/model <id>` or the list leaves free mode.
- The chain is saved (`free.json` in the data folder) and restored at start
  when the saved primary is still the model.

## Module

`src/free-models.js`: `freeCandidates(models)`, `endpointStats(endpoints)`,
`rankFree(list)`, `freeChain(ranked)`, `dailyFreeLimit(keyInfo)`,
`loadFreeModels({ fetchJson })`, usage counting (`recordFreeRequest`,
`freeUsedToday`), the saved chain (`saveFreeChain`, `loadFreeChain`), and
`servedModelNotice(primary, served)`.

## Acceptance

| # | Criterion | Test |
|---|---|---|
| F1 | Candidates: zero prompt and completion price, tool calling, text output; a free model without `:free` is in, a paid one or one without tools is out; stealth models are flagged. | `tests/unit/free-models.test.js` |
| F2 | Stats come from the best endpoint (by uptime) of each model; missing numbers stay missing. | `free-models.test.js` |
| F3 | Ranking and chain: available before unavailable, then speed; fallbacks from vendors other than the primary's and each other's. | `free-models.test.js` |
| F4 | The daily limit is 50 on the free tier and 1,000 otherwise; today's count resets the next day. | `free-models.test.js` |
| F5 | In free mode the main model's request carries `models` with the chain; side calls and other providers do not. | `free-models.test.js` |
| F6 | A different serving model gives one notice per change; a 402 in free mode explains the negative balance. | `free-models.test.js` |
| F7 | `/model free auto` sets the model and the chain and saves them; `/model <id>` clears the chain; `/model free` opens the list. | `free-models.test.js` |
| F8 | Live: `/model free auto` on the real API, one turn answered, footer count and chain shown. | manual, recorded in the commit |
