// With a step ceiling of 500, "unlimited" money would leave a runaway turn with
// no guard at all. An unset AGENT_MAX_COST therefore means a documented default
// per-turn ceiling; an explicit value, including 0 (unlimited), is the
// operator's choice and is kept as given.
import { describe, it, expect, vi } from "vitest";

async function load(env) {
  const saved = {};
  for (const k of ["AGENT_MAX_COST", "AGENT_SESSION_BUDGET"]) { saved[k] = process.env[k]; delete process.env[k]; }
  Object.assign(process.env, env);
  vi.resetModules();
  try {
    return (await import("../../src/config.js")).config;
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    vi.resetModules();
  }
}

describe("per-turn cost ceiling", () => {
  it("defaults to a positive ceiling when AGENT_MAX_COST is unset", async () => {
    const c = await load({});
    expect(c.maxCostPerAction).toBeGreaterThan(0);
    expect(c.maxCostPerAction).toBe(5);
  });
  it("an explicit AGENT_MAX_COST=0 still means unlimited", async () => {
    expect((await load({ AGENT_MAX_COST: "0" })).maxCostPerAction).toBe(0);
  });
  it("an explicit value is kept", async () => {
    expect((await load({ AGENT_MAX_COST: "0.25" })).maxCostPerAction).toBe(0.25);
  });
  // A value that is not a usable amount must not switch the guard off or turn
  // it into nonsense: a negative ceiling is below every cost, and NaN compares
  // false with everything, which reads as "no limit".
  it("a negative or unreadable AGENT_MAX_COST falls back to the default ceiling", async () => {
    expect((await load({ AGENT_MAX_COST: "-1" })).maxCostPerAction).toBe(5);
    expect((await load({ AGENT_MAX_COST: "five dollars" })).maxCostPerAction).toBe(5);
    expect((await load({ AGENT_MAX_COST: "" })).maxCostPerAction).toBe(5);
  });
  it("the session budget stays unlimited unless set", async () => {
    expect((await load({})).sessionBudget).toBe(0);
    expect((await load({ AGENT_SESSION_BUDGET: "20" })).sessionBudget).toBe(20);
  });
});
