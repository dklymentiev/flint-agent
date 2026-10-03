// Every source the accounting declares must actually be recordable.
//
// USAGE_SOURCES is the list a reader trusts to answer "what is the bill made
// of". emptyLedger() used to repeat that list by hand, so a source could be
// declared and still have no row, and recordUsage dropped it with a bare
// `return null`. That is what happened to `outcome`: eleven model calls on the
// readiness run of 2026-09-21 were made, answered, and never billed. The
// session total looked fine because nothing was missing from it that anyone
// could see.

import { describe, it, expect, beforeEach } from "vitest";
import { USAGE_SOURCES, recordUsage, drainUsage, resetSessionSpend } from "../../../src/agent/usage.js";

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
