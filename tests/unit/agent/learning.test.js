// Tests for Learning System
import { describe, it, expect } from "vitest";
import { extractLearnings } from "../../../src/agent/learning.js";
import { getAll } from "../../../src/agent/knowledge.js";

describe("extractLearnings", () => {
  it("extracts pattern from tool sequence", () => {
    const before = getAll().length;
    // Use unique tool combo to avoid dedup with previously-known patterns
    const uniqueId = Date.now();
    extractLearnings({
      messages: [
        { role: "user", content: "unique task " + uniqueId },
        { role: "assistant", tool_calls: [{ function: { name: "uniq_tool_a_" + uniqueId, arguments: '{}' } }] },
        { role: "tool", content: "ok" },
        { role: "assistant", tool_calls: [{ function: { name: "uniq_tool_b_" + uniqueId, arguments: '{}' } }] },
        { role: "tool", content: "ok" },
        { role: "assistant", tool_calls: [{ function: { name: "uniq_tool_c_" + uniqueId, arguments: '{}' } }] },
        { role: "tool", content: "ok" },
      ],
      task: "unique task " + uniqueId,
      plan: { goal: "unique goal", tasks: [{ id: 1 }, { id: 2 }] },
      outcome: "success",
    });
    const after = getAll().length;
    expect(after).toBeGreaterThan(before);
  });

  it("does not learn from failures", () => {
    const before = getAll().length;
    extractLearnings({
      messages: [
        { role: "assistant", tool_calls: [{ function: { name: "fail_tool", arguments: '{}' } }] },
      ],
      task: "broken task",
      plan: null,
      outcome: "failed",
    });
    expect(getAll().length).toBe(before);
  });

  it("does not learn from single tool call", () => {
    const before = getAll().length;
    extractLearnings({
      messages: [
        { role: "assistant", tool_calls: [{ function: { name: "read_file", arguments: '{"path":"a.txt"}' } }] },
      ],
      task: "read a file",
      plan: null,
      outcome: "success",
    });
    expect(getAll().length).toBe(before);
  });
});
