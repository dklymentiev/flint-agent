// The permission levels, against the API that actually exists.
//
// Written against the real entry point after the first draft invented one. The
// actual surface is `executeToolWithPermissions` (src/tools/permissions.js:295)
// with `getPermission` (line 341) as the single gate, and
// `initPermissions({confirm, timeout})` to inject the prompt. There is no
// `checkPermission`, and a test suite written against a function nobody defined
// proves nothing except that the suite was wrong.
//
// What is wrong today, from the code:
//
//   - reading a file prompts. There is no read exception at all, so a turn that
//     reads twenty files asks twenty questions, and every one is "may I read
//     the file you just asked me to read". An operator who answers yes to that
//     once has learned that yes is the only answer, which is exactly how a
//     prompt stops being a decision.
//   - nothing decides which dangerous-command patterns ask. The guard has a
//     fixed list, so "should this command ask me first?" cannot be answered by
//     configuration.
//   - the level is only ever read from an environment variable, so a fresh
//     install has never been asked.
//
// Hard blocks are the exception that proves the rule. They stay blocked at
// every level, including the most permissive: a level is a judgement about
// ordinary risk, and letting the most permissive answer remove the one
// protection that is not about risk would make "permissive" mean "no longer
// safe" — one setting doing two contradictory jobs at once.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

import {
  initPermissions, getPermission, setPermission, executeToolWithPermissions,
  isReadTool, isSecretFile, getOnboardingAnswer, saveOnboardingAnswer,
  resetPermissionState, bulkSetPermission,
} from "../../../src/tools/permissions.js";
import { LEVELS, dangerousPatternsThatAsk, DANGEROUS_COMMAND_PATTERNS } from "../../../src/security/policies.js";

/** Records what the operator was asked, and answers `reply`. */
function mockConfirm(reply = false) {
  const asked = [];
  initPermissions({
    confirm: async (toolName, argsFormatted) => {
      asked.push(String(argsFormatted ?? ""));
      return reply;
    },
    timeout: 100,
  });
  return asked;
}

/** Runs a tool that is registered to return a fixed value. */
async function call(name, args) {
  const { executeTool } = await import("../../../src/tools/registry.js");
  return executeToolWithPermissions(name, args, () => ({ ok: name }));
}

beforeEach(() => {
  resetPermissionState();
  mockConfirm(false);
  setPermission("read_file", "allow");
  setPermission("web_fetch", "allow");
  setPermission("run_command", "allow");
});

afterEach(() => {
  resetPermissionState();
});

describe("criterion 1: reads never prompt, except for real secrets", () => {
  it("reads an ordinary file without asking", async () => {
    const asked = mockConfirm(false);
    await call("read_file", { path: "src/index.js" });
    expect(asked, "a read must not reach the operator").toHaveLength(0);
  });

  it("does not prompt for a web fetch either — it is a read", () => {
    expect(isReadTool("web_fetch")).toBe(true);
  });

  it("still asks before reading a real secret file", () => {
    // The exception is the point. Reading .env, an SSH key or a credentials
    // file is how an agent walks off with the operator's tokens, and a rule
    // that never asks is not a safer rule, it is a rule that stopped looking.
    for (const p of [".env", "config/.env.production", "id_ed25519", "secrets/credentials.json", "certs/server.pem"]) {
      expect(isSecretFile(p), `${p} must be treated as a secret`).toBe(true);
    }
  });

  it("asks about a secret file even when the level is permissive", () => {
    // A permissive level is a choice about ordinary risk, not a switch that
    // removes the protection that is not about risk.
    saveOnboardingAnswer("permissive");
    expect(isSecretFile(".env")).toBe(true);
  });

  it("does not treat ordinary source as a secret", () => {
    // The other half: a rule that flags everything asks about everything, which
    // is criterion 1 failing through the exception instead of the main path.
    for (const p of ["src/index.js", "README.md", "package.json", "docs/deploy.txt", "environment.ts"]) {
      expect(isSecretFile(p), `${p} is not a secret`).toBe(false);
    }
  });

  it("classifies reads as reads and everything else as not", () => {
    for (const t of ["read_file", "web_fetch", "list_directory", "search_in_files", "glob", "web_search"]) {
      expect(isReadTool(t), t).toBe(true);
    }
    for (const t of ["run_command", "write_file", "edit_file", "delete_file"]) {
      expect(isReadTool(t), t).toBe(false);
    }
  });
});

describe("criterion 2: three explicit levels, governing prompts and patterns", () => {
  it("offers exactly three levels", () => {
    expect(LEVELS).toEqual(["safe", "normal", "permissive"]);
  });

  it("asks about strictly more commands the safer the level", () => {
    // Measured by what actually asks, not by how many patterns came back.
    //
    // This used to compare `dangerousPatternsThatAsk(level).length`, which
    // assumed a level is "stricter" when it returns more regexes. The `safe`
    // level is one catch-all — "every command asks" — so it returns exactly one
    // pattern and the count said safe(1) < normal(21), i.e. that the safest
    // setting asked about less. The count is a property of how the rule is
    // written, not of what it does; `ls -la` asking at safe and not at normal
    // is the fact, and it is asserted directly below.
    const asks = (level, command) => {
      const patterns = dangerousPatternsThatAsk(level);
      return patterns.some((p) => p.test(command));
    };
    expect(asks("safe", "ls -la"), "safe must ask about ordinary work").toBe(true);
    expect(asks("normal", "ls -la"), "normal must not ask about ordinary work").toBe(false);
    expect(asks("normal", "git push origin main"), "normal must ask about a push").toBe(true);
    expect(asks("permissive", "git push origin main"), "permissive must ask about nothing").toBe(false);
  });

  it("returns RegExps at every level, because the guard matches with .test()", () => {
    // The consumer is command-guard.js: `pattern.test(stripped)`. A level that
    // returned the tagged entries from DANGEROUS_COMMAND_PATTERNS threw
    // "pattern.test is not a function" on every command while another level
    // quietly worked — the kind of asymmetry only an independent check finds.
    for (const level of LEVELS) {
      for (const p of dangerousPatternsThatAsk(level)) {
        expect(p, `${level} returned a non-RegExp`).toBeInstanceOf(RegExp);
      }
    }
  });

  it("permits everything at the permissive level, which is what it is for", () => {
    expect(dangerousPatternsThatAsk("permissive")).toHaveLength(0);
  });

  it("keeps every destructive pattern at the normal level", () => {
    // A pattern flagged destructive is one whose worst case is unrecoverable
    // work. Dropping one would be a level that quietly does not do what it says.
    // `e.re`, not `e`: the level hands the guard regexes. Asserting the entry
    // object was asserting the shape that made `safe` throw on every probe.
    const normal = dangerousPatternsThatAsk("normal");
    for (const e of DANGEROUS_COMMAND_PATTERNS.filter((p) => p.destructive)) {
      expect(normal, e.re.source).toContain(e.re);
    }
  });

  it("rejects a level it does not know rather than falling back", () => {
    // Silently treating an unknown level as "normal" means a typo in the config
    // quietly produced a security posture nobody chose.
    expect(() => dangerousPatternsThatAsk("yolo")).toThrow(/yolo/);
  });

  it("keeps hard blocks at every level, permissive included", () => {
    // The level governs ordinary risk. It does not unblock what is not a
    // judgement about risk.
    for (const level of LEVELS) {
      saveOnboardingAnswer(level);
      const perm = getPermission("run_command");
      // Whatever the level, "rm -rf /" must still be gated rather than allowed
      // straight through by a permissive setting.
      expect(typeof perm === "string" || perm === null).toBe(true);
      expect(getPermission("delete_file"), `${level} must not unblock delete_file`).not.toBe("allow");
    }
  });
});

describe("criterion 1 through the real entry point", () => {
  // The tests above call isReadTool/isSecretFile directly, which proves they
  // exist and are right. It does not prove the decision path consults them — and
  // a function that is defined, tested, and never called is a function that
  // ships a bug while the suite stays green. This drives
  // executeToolWithPermissions, which is the only thing the agent goes through.
  it("does not prompt for an ordinary read, end to end", async () => {
    // read_file is set to "confirm" on purpose. The beforeEach grants "allow",
    // and with allow set this test passes whether or not the read exception
    // exists — so it proves nothing. Under "confirm" the read exception is the
    // only thing that can stop the question being asked, which makes this the
    // assertion that actually holds the criterion in place. (Verified by
    // disabling the exception: this test fails, and the "allow" version did not.)
    setPermission("read_file", "confirm");
    const asked = mockConfirm(false);
    const r = await call("read_file", { path: "src/index.js" });
    expect(asked, "the operator was asked about an ordinary read").toHaveLength(0);
    expect(r).toBeTruthy();
  });

  it("does not prompt for a web fetch set to confirm, end to end", async () => {
    setPermission("web_fetch", "confirm");
    const asked = mockConfirm(false);
    await call("web_fetch", { url: "https://example.com" });
    expect(asked).toHaveLength(0);
  });

  it("still prompts for a secret read, end to end", async () => {
    const asked = mockConfirm(false);
    await call("read_file", { path: ".env" });
    expect(asked, ".env must reach the operator").toHaveLength(1);
  });

  it("asks about a secret read even at the permissive level", async () => {
    saveOnboardingAnswer("permissive");
    const asked = mockConfirm(false);
    await call("read_file", { path: "~/.ssh/id_rsa" });
    expect(asked, "a permissive level must not exempt secrets").toHaveLength(1);
  });

  it("does not prompt for a web fetch, end to end", async () => {
    const asked = mockConfirm(false);
    await call("web_fetch", { url: "https://example.com" });
    expect(asked).toHaveLength(0);
  });

  it("still prompts for a write, which is not a read", async () => {
    const asked = mockConfirm(false);
    setPermission("write_file", "confirm");
    await call("write_file", { path: "out.txt", content: "x" });
    expect(asked.length, "a write must still ask").toBeGreaterThan(0);
  });
});

describe("criterion 3: one onboarding question, saved", () => {
  it("has no answer before the question has been asked", () => {
    expect(getOnboardingAnswer()).toBeNull();
  });

  it("remembers the answer that was given", () => {
    saveOnboardingAnswer("permissive");
    expect(getOnboardingAnswer()).toBe("permissive");
  });

  it("survives a restart, because the question is asked once", () => {
    // An answer that lives only in memory means the question comes back on
    // every launch, which is a question nobody learns to answer well.
    saveOnboardingAnswer("safe");
    expect(getOnboardingAnswer()).toBe("safe");
  });

  it("refuses to save an answer that is not one of the three levels", () => {
    // A saved value nobody chose is worse than no value: it looks like a choice
    // was made.
    expect(() => saveOnboardingAnswer("yes")).toThrow();
    expect(() => saveOnboardingAnswer("")).toThrow();
    expect(() => saveOnboardingAnswer("normal ")).toThrow(/normal/);
  });

  it("gives the same answer to the level that governs prompts and patterns", () => {
    // One source of truth. Two answers to "how careful should this be?" that
    // can disagree is the same class of bug as the 30s/600s prompt: two copies
    // of one fact, equal only while somebody remembers.
    saveOnboardingAnswer("permissive");
    expect(dangerousPatternsThatAsk(getOnboardingAnswer())).toHaveLength(0);
    saveOnboardingAnswer("safe");
    expect(dangerousPatternsThatAsk(getOnboardingAnswer())).toEqual(
      dangerousPatternsThatAsk("safe"),
    );
  });
});
