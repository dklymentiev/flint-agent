// Every tool the agent can call has to have an answer in the permission table.
//
// WHY THIS FILE EXISTS
//
// The operator's complaint was "why does task_stats stop the turn to ask me a
// question". The cause was not a wrong level — it was that eight tools had no
// entry in DEFAULT_PERMISSIONS at all, and getPermission() answers "confirm"
// for a tool it has never heard of. The eight were fixed by hand, and every
// tool added after them will be missing in the same silent way, one at a time,
// discovered by an operator reading a prompt rather than by a test.
//
// So the rule is asserted here instead of the list being maintained twice:
// nothing may reach the unknown-tool default. A new tool that arrives without a
// decision fails AT THE COMMIT THAT ADDED IT, not six weeks later in a prompt.
//
// The unknown-tool default itself stays "confirm" — it is the right answer for a
// plugin or an MCP server registering a tool nobody has reviewed. This file
// does not argue against it. It argues that no FIRST-PARTY tool should be
// relying on it.

import { describe, it, expect } from "vitest";
import { initRegistry, getDefinitions } from "../../../src/tools/registry.js";
import { createTaskTools } from "../../../src/tools/tasks.js";
import { createInboxTools } from "../../../src/tools/inbox-tools.js";
import { datasetToolDefs } from "../../../src/tools/dataset.js";
import { agentToolDefs } from "../../../src/tools/agent-tools.js";
import { getPermission, getPermissionMap } from "../../../src/tools/permissions.js";
import { createMockStore } from "../../helpers/mock-store.js";

// First-party tools with no table entry, and why. An allowlist of exceptions is
// what lets an assertion like this survive the next commit.
//
// Empty as of 2026-09-30, and that is the point rather than an accident: the
// thirteen names that were missing when this file was written have all been
// given an answer, so every tool the agent can call now has one. Adding to this
// set is a decision to let a tool ask on every call — which is what it does
// today, silently, and what the operator asked to be rid of.
const EXPECTED_UNLISTED = new Set();

function firstPartyToolNames() {
  const store = createMockStore();
  initRegistry(store);
  // registry.js carries the built-ins; these four are registered afterwards by
  // bootstrap.initTools(). All first-party, all in scope.
  const extra = [
    ...createTaskTools({ getStore: () => store }).tools,
    ...createInboxTools(),
    ...datasetToolDefs,
    ...agentToolDefs,
  ];

  const names = new Set(getDefinitions().map((t) => t.function?.name).filter(Boolean));
  for (const def of extra) names.add(def.function?.name);
  return [...names].sort();
}

describe("permission coverage", () => {
  const names = firstPartyToolNames();
  // getPermissionMap enumerates DEFAULT_PERMISSIONS' keys plus saved overrides,
  // so a name in it has an entry and a name outside it has none. Membership, not
  // the returned level: "confirm" is a fine answer when it was chosen, and a
  // bug when it is what an unknown tool falls through to.
  const hasEntry = new Set(Object.keys(getPermissionMap()));

  it("actually collected the tool list (guard against a vacuous scan)", () => {
    // Without this the whole file passes if an import path breaks and the
    // collector returns [] — which is exactly how a test like this dies quietly.
    expect(names.length).toBeGreaterThan(40);
    expect(names).toContain("read_file");
    expect(names).toContain("task_stats");
  });

  it("no first-party tool relies on the unknown-tool default", () => {
    const missing = names.filter((n) => !EXPECTED_UNLISTED.has(n) && !hasEntry.has(n));
    expect(missing, `no entry for: ${missing.join(", ")}`).toEqual([]);
  });

  it("EXPECTED_UNLISTED has not gone stale", () => {
    // The allowlist is itself a place a tool can rot: a name that now HAS an
    // entry is dead weight that hides the tool from the rule above. Fail, so
    // the entry gets removed here rather than becoming a permanent exemption.
    const stale = [...EXPECTED_UNLISTED].filter((n) => !names.includes(n) || hasEntry.has(n));
    expect(stale).toEqual([]);
  });

  it("the tools that were silently asking are allow", () => {
    // Named one by one rather than derived, so reverting the fix fails here
    // with the tool name in the message instead of a list mismatch.
    for (const name of [
      "task_stats", "list_goals", "focus_goal", "wait_tasks",
      "list_mcp_servers", "today", "create_subtask",
      "memory_expand", "skill_add", "skill_update", "skill_remove",
    ]) {
      expect(getPermission(name), `${name} should not prompt`).toBe("allow");
    }
  });

  it("reconnect_mcp still asks — it is not a read", () => {
    // The one tool of the eight left on purpose: it rebuilds a session against
    // a server on the operator's own machine, and a tool that has been failing
    // with "fetch failed" is a tool whose name has just come out of an error
    // message. That is a question worth asking.
    expect(getPermission("reconnect_mcp")).toBe("confirm");
  });
});
