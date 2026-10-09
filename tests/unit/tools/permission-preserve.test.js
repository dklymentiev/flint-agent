// Regression test: saveOverridesToDisk in permissions.js must not clobber
// _commandApprovals written by command-approvals.js to the same file.
//
// Before the fix, saveOverridesToDisk wrote { ...sessionOverrides } — a blind
// overwrite that dropped every key command-approvals.js had persisted.  The
// gap-4 "survives a restart" test in permission-checks.test.js depends on the
// round-trip grant → persist → _resetForTest → load working; when
// saveOverridesToDisk (called by beforeEach's setPermission) runs after
// persist(), the _commandApprovals key vanishes and getCommandApproval
// returns false instead of true.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { config } from "../../../src/config.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

beforeEach(() => {
  // Start clean — the permissions file might have leftover data from other
  // test files in the same worker.
  const permsFile = config.permissionsFile;
  if (existsSync(permsFile)) {
    writeFileSync(permsFile, JSON.stringify({
      read_file: "allow",
      web_fetch: "allow",
      run_command: "allow",
      write_file: "allow",
      edit_file: "allow",
    }, null, 2) + "\n");
  }
});

describe("saveOverridesToDisk preserves _commandApprovals", () => {
  it("does not drop command approvals when setPermission writes levels", async () => {
    const { grantCommandApproval, getCommandApproval, _resetForTest } = await import("../../../src/tools/command-approvals.js");
    const { setPermission, resetPermissionState } = await import("../../../src/tools/permissions.js");

    // Grant a command — this calls persist() which writes _commandApprovals
    grantCommandApproval({ cwd: "/work/repo-a", command: "npm test" });

    // Simulate what beforeEach does: call setPermission which triggers
    // saveOverridesToDisk — this used to overwrite the file and drop _commandApprovals
    resetPermissionState();
    setPermission("read_file", "allow");

    // _resetForTest simulates a restart by clearing the in-memory cache
    _resetForTest();

    // The command approval should survive the setPermission write
    expect(getCommandApproval({ cwd: "/work/repo-a", command: "npm test" })).toBe(true);
  });
});
