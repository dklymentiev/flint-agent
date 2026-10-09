// Tests for stop_reason in agent responses
import { describe, it, expect } from "vitest";
import { getSystemMessage } from "../../../src/agent/system-prompt.js";

describe("system prompt - always plan rule", () => {
  it("contains core principles and intent routing from system.md", () => {
    const msg = getSystemMessage();
    expect(msg.content).toContain("Core Principles");
    expect(msg.content).toContain("Intent Layer");
    expect(msg.content).toContain("Verify");
  });
});

describe("stop_reason values", () => {
  // These are structural tests — verify the stop_reason contract.
  // Full integration tests require mocking the LLM API.

  // "denied" (dc2bc57): the turn ended because one tool was refused three times
  // and the agent kept rephrasing the call to get the same command past the
  // same rule. Distinct from "loop", which is about repetition alone and says
  // nothing about what was refused.
  //
  // "loop" and "supervisor" are gone: loop detectors and the
  // supervisor nudge, they no longer end a turn. The step ceiling does.
  // "stall": a model call the provider accepted and never answered, dropped
  // three times in a row. On 2026-09-29 one sat for the full 600s hard
  // timeout, twice, with nothing on screen but a status line.
  //
  // "text-tool-call": the model wrote its tool call into the answer instead of
  // calling the tool, so nothing ran. Said rather than returned as "done".
  // "model-not-found": the provider answered 404 for this model; retrying gets
  // the same answer, so the turn ends at once (the stdio result carries it).
  const VALID_STOP_REASONS = [
    "done", "budget", "error", "denied", "rate-limit", "auth", "quota", "empty",
    "stall", "text-tool-call", "model-not-found",
  ];

  it("defines all expected stop reasons", () => {
    // Grep agent.js source to verify all stop_reasons are from expected set
    const fs = require("fs");
    const source = fs.readFileSync("src/agent/agent.js", "utf-8");
    // The character class takes a hyphen, not just \w: "rate-limit" and
    // "text-tool-call" are both real reasons, and a \w+ pattern silently
    // skipped them — an inventory test that cannot see half the inventory.
    const matches = [...source.matchAll(/stop_reason:\s*"([\w-]+)"/g)];
    const reasons = [...new Set(matches.map(m => m[1]))];

    for (const reason of reasons) {
      expect(VALID_STOP_REASONS).toContain(reason);
    }
    // Must have all expected reasons somewhere
    expect(reasons).toContain("done");
    expect(reasons).toContain("budget");
    expect(reasons).toContain("error");
    expect(reasons).toContain("denied");
    expect(reasons).not.toContain("loop");
    expect(reasons).not.toContain("supervisor");
  });

  it("message-handler propagates stop_reason", () => {
    const fs = require("fs");
    const source = fs.readFileSync("src/message-handler.js", "utf-8");
    // Must destructure stop_reason from runAgent
    expect(source).toContain("stop_reason");
    // Must return stop_reason in result
    expect(source).toMatch(/return.*stop_reason/);
  });

  it("drain-loop delegates flow decisions to flow-controller", () => {
    const fs = require("fs");
    const source = fs.readFileSync("src/bus/drain-loop.js", "utf-8");
    expect(source).toContain("shouldContinue");
    expect(source).toContain('"budget"');
    expect(source).toContain("flow-controller");
  });
});

describe("drain-loop auto-continue logic", () => {
  it("flow-controller handles no-plan and plan-done cases", () => {
    const fs = require("fs");
    const source = fs.readFileSync("src/agent/flow-controller.js", "utf-8");
    expect(source).toContain("!plan");
    expect(source).toContain("!hasPending");
    expect(source).toContain("action: \"stop\"");
    expect(source).toContain("goalComplete");
    expect(source).toContain("action: \"continue\"");
  });

  it("does not auto-continue on budget stop", () => {
    const fs = require("fs");
    const source = fs.readFileSync("src/bus/drain-loop.js", "utf-8");
    expect(source).toContain('stopReason !== "budget"');
  });
});
