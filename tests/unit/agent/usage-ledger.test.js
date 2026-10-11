// Every source the accounting declares must actually be recordable.
//
// USAGE_SOURCES is the list a reader trusts to answer "what is the bill made
// of". emptyLedger() used to repeat that list by hand, so a source could be
// declared and still have no row, and recordUsage dropped it with a bare
// `return null`. That is what happened to `outcome`: eleven model calls on the
// readiness run of 2026-09-21 were made, answered, and never billed. The
// session total looked fine because nothing was missing from it that anyone
// could see.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { USAGE_SOURCES, recordUsage, drainUsage, resetSessionSpend, setPricingSource } from "../../../src/agent/usage.js";

const usage = { prompt_tokens: 100, completion_tokens: 20, cost: 0.0005 };

beforeEach(() => {
  resetSessionSpend();
});

describe("the ledger", () => {
  it("has a row for every declared source", () => {
    // `agent` included. It used to be the exception, on the grounds that
    // the main loop kept its own stats — which is exactly how the main loop
    // ended up priced by a different formula than everything else.
    for (const source of USAGE_SOURCES) recordUsage(source, usage);
    const ledger = drainUsage();

    expect(Object.keys(ledger).sort()).toEqual([...USAGE_SOURCES].sort());
    for (const source of USAGE_SOURCES) {
      expect(ledger[source].calls, `${source} was declared but not recorded`).toBe(1);
      expect(ledger[source].cost).toBeGreaterThan(0);
    }
  });

  it("records the out-of-band outcome question", () => {
    recordUsage("outcome", usage);
    const ledger = drainUsage();
    expect(ledger.outcome.calls).toBe(1);
    expect(ledger.outcome.promptTokens).toBe(100);
  });

  it("counts a call whose cost the provider did not report, as estimated", () => {
    recordUsage("outcome", null);
    const ledger = drainUsage();
    expect(ledger.outcome.calls).toBe(1);
    expect(ledger.outcome.estimated).toBe(true);
  });

  it("does not invent a row for a source nobody declared", () => {
    expect(recordUsage("nonesuch", usage)).toBe(null);
    expect(drainUsage().nonesuch).toBeUndefined();
  });
});

// A call is priced by the card of the model that made it. The ledger knew one
// card, the main model's, so a turn that carried on with the fallback model
// would have been billed at the main model's rate whenever the provider sent
// no cost of its own.
describe("the rate card of a call that is not on the main model", () => {
  const bare = { prompt_tokens: 1000, completion_tokens: 100 };
  const mainCard = { prompt: 0.001, completion: 0.002 };

  beforeEach(() => { setPricingSource(() => mainCard); });
  afterEach(() => { setPricingSource(null); });

  it("is its own when the caller gives one", () => {
    const entry = recordUsage("agent", bare, { prompt: 0.00001, completion: 0.00002 });
    expect(entry.cost).toBeCloseTo(1000 * 0.00001 + 100 * 0.00002, 10);
    expect(entry.estimated).toBe(true);
  });

  it("is unknown, not the main model's, when the caller says so: cost 0, flagged", () => {
    const entry = recordUsage("agent", bare, null);
    expect(entry.cost).toBe(0);
    expect(entry.estimated).toBe(true);
  });

  it("is the main model's when the caller says nothing", () => {
    const entry = recordUsage("agent", bare);
    expect(entry.cost).toBeCloseTo(1000 * 0.001 + 100 * 0.002, 10);
  });

  it("gives way to the provider's own figure", () => {
    const entry = recordUsage("agent", { ...bare, cost: 0.5 }, null);
    expect(entry.cost).toBe(0.5);
    expect(entry.estimated).toBe(false);
  });
});
