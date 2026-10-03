// Self-update (docs/self-update.md, U1-U6).
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  compareVersions, latestTag, installKind, checkForUpdate, updateNotice, changelogBetween, runUpdate,
} from "../../src/update.js";

let dir;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "flint-update-")); });

/** A fake command runner: answers by "cmd arg1 arg2", records every call. */
function fakeExec(answers = {}) {
  const calls = [];
  const exec = (cmd, args = []) => {
    const key = [cmd, ...args].join(" ");
    calls.push(key);
    for (const [k, v] of Object.entries(answers)) {
      if (key.startsWith(k)) {
        if (v instanceof Error) throw v;
        return typeof v === "function" ? v(key) : v;
      }
    }
    return "";
  };
  return { exec, calls };
}

describe("versions (U1)", () => {
  it("compare as numbers", () => {
    expect(compareVersions("1.10.0", "1.9.1")).toBe(1);
    expect(compareVersions("1.11.0", "1.11.0")).toBe(0);
    expect(compareVersions("v1.2.3", "1.2.10")).toBe(-1);
  });

  it("the newest v-tag wins, whatever the order", () => {
    expect(latestTag("v1.9.1\nv1.10.0\nnot-a-version\nv1.8.0\n")).toBe("1.10.0");
    expect(latestTag("")).toBeNull();
  });
});

describe("install kind (U2)", () => {
  it("git with a .git folder, npm under node_modules, none otherwise", () => {
    expect(installKind("/x/flint", { exists: (p) => p.endsWith(".git") })).toBe("git");
    expect(installKind("/usr/lib/node_modules/flint-agent", { exists: () => false })).toBe("npm");
    expect(installKind("/x/flint", { exists: () => false })).toBe("none");
  });
});

describe("the check (U3)", () => {
  const cacheFile = () => path.join(dir, "update-check.json");

  it("git: newest tag after a fetch; a newer one gives a notice; once a day", async () => {
    const { exec, calls } = fakeExec({ "git fetch": "", "git tag": "v1.10.1\nv1.11.0\nv1.11.1\n" });
    const now = Date.parse("2026-10-03T09:00:00Z");
    const r = await checkForUpdate({ root: dir, current: "1.11.0", kind: "git", now, cacheFile: cacheFile(), exec });
    expect(r).toEqual({ current: "1.11.0", latest: "1.11.1", newer: true });
    expect(calls[0]).toBe("git fetch --tags --quiet origin");
    expect(updateNotice(r)).toBe("Flint 1.11.1 is out (you have 1.11.0). /update installs it.");
    const again = await checkForUpdate({ root: dir, current: "1.11.0", kind: "git", now: now + 3600e3, cacheFile: cacheFile(), exec });
    expect(again.latest).toBe("1.11.1");
    expect(calls.filter((c) => c.startsWith("git fetch"))).toHaveLength(1);   // cached
    expect(JSON.parse(readFileSync(cacheFile(), "utf8")).latest).toBe("1.11.1");
  });

  it("up to date or failing: nothing to say", async () => {
    const upToDate = fakeExec({ "git tag": "v1.11.0\n" });
    const r = await checkForUpdate({ root: dir, current: "1.11.0", kind: "git", now: 1, cacheFile: cacheFile(), exec: upToDate.exec });
    expect(r.newer).toBe(false);
    expect(updateNotice(r)).toBeNull();
    const failing = fakeExec({ "git fetch": new Error("could not read Username") });
    expect(await checkForUpdate({ root: dir, current: "1.11.0", kind: "git", now: 1, cacheFile: path.join(dir, "c2.json"), exec: failing.exec })).toBeNull();
  });

  it("npm: asks the registry", async () => {
    const r = await checkForUpdate({ root: dir, current: "1.11.0", kind: "npm", now: 1, cacheFile: cacheFile(), fetchJson: async (url) => {
      expect(url).toBe("https://registry.npmjs.org/flint-agent/latest");
      return { version: "1.12.0" };
    } });
    expect(r).toEqual({ current: "1.11.0", latest: "1.12.0", newer: true });
  });
});

describe("the changelog in between (U6)", () => {
  it("the sections newer than the current version, up to the latest", () => {
    const log = "# Changelog\n\n## [1.12.0] — x\n\nC\n\n## [1.11.1] — x\n\nB\n\n## [1.11.0] — x\n\nA\n";
    const s = changelogBetween(log, "1.11.0", "1.12.0");
    expect(s).toContain("## [1.12.0]");
    expect(s).toContain("## [1.11.1]");
    expect(s).not.toContain("## [1.11.0]");
  });
});

describe("/update (U4, U5)", () => {
  const base = (over = {}) => ({
    "git status --porcelain --untracked-files=no": "",
    "git rev-parse --abbrev-ref HEAD": "master\n",
    "git rev-parse HEAD": "aaa111\n",
    "git fetch --tags origin": "",
    "git tag": "v1.11.0\nv1.11.1\n",
    "git merge --ff-only origin/master": "",
    "git diff --name-only aaa111": "src/agent.js\n",
    ...over,
  });
  const run = async (answers, extra = {}) => {
    const { exec, calls } = fakeExec(answers);
    const lines = [];
    let restarted = false;
    const r = await runUpdate({ root: dir, kind: "git", current: "1.11.0", exec, log: (l) => lines.push(l), restart: () => { restarted = true; }, readChangelog: () => "", ...extra });
    return { r, calls, text: lines.join("\n"), restarted };
  };

  it("refuses with changes of one's own, and touches nothing", async () => {
    const { r, calls, text, restarted } = await run(base({ "git status --porcelain --untracked-files=no": " M src/index.js\n" }));
    expect(r.ok).toBe(false);
    expect(text).toMatch(/changes of your own/i);
    expect(calls.some((c) => c.startsWith("git merge") || c.startsWith("npm"))).toBe(false);
    expect(restarted).toBe(false);
  });

  // npm rewrites package-lock.json on every install, and two npm versions write
  // it differently, so a plain `npm install` (or /update's own) left a change
  // that was never the operator's, and every later /update refused.
  it("a package-lock.json that only npm touched is put back, and the update goes on", async () => {
    const { r, calls, restarted } = await run(base({ "git status --porcelain --untracked-files=no": " M package-lock.json\n" }));
    expect(r).toMatchObject({ ok: true, updated: true, latest: "1.11.1" });
    const restore = calls.indexOf("git checkout -- package-lock.json");
    expect(restore).toBeGreaterThan(-1);
    expect(restore).toBeLessThan(calls.indexOf("git merge --ff-only origin/master"));
    expect(calls.some((c) => c.startsWith("npm install"))).toBe(true);   // node_modules follows the restored lock
    expect(restarted).toBe(true);
  });

  it("a lock change next to changes of one's own still refuses, and the lock is left alone", async () => {
    const { r, calls } = await run(base({ "git status --porcelain --untracked-files=no": " M package-lock.json\n M src/index.js\n" }));
    expect(r.ok).toBe(false);
    expect(calls.some((c) => c.startsWith("git checkout") || c.startsWith("git merge"))).toBe(false);
  });

  it("refuses off master", async () => {
    const { r, text } = await run(base({ "git rev-parse --abbrev-ref HEAD": "my-branch\n" }));
    expect(r.ok).toBe(false);
    expect(text).toMatch(/my-branch/);
  });

  it("refuses when it cannot fast-forward", async () => {
    const { r, calls, text } = await run(base({ "git merge --ff-only origin/master": new Error("Not possible to fast-forward") }));
    expect(r.ok).toBe(false);
    expect(text).toMatch(/fast-forward/i);
    expect(calls.some((c) => c.startsWith("npm"))).toBe(false);
  });

  it("says when it is up to date", async () => {
    const { r, calls } = await run(base({ "git tag": "v1.11.0\n" }));
    expect(r).toMatchObject({ ok: true, updated: false });
    expect(calls.some((c) => c.startsWith("git merge"))).toBe(false);
  });

  it("fetches, fast-forwards, skips npm install when no package file changed, restarts", async () => {
    const { r, calls, restarted } = await run(base());
    expect(r).toMatchObject({ ok: true, updated: true, latest: "1.11.1" });
    expect(calls).toContain("git merge --ff-only origin/master");
    expect(calls.some((c) => c.startsWith("npm install"))).toBe(false);
    expect(restarted).toBe(true);
  });

  it("runs npm install when the package files changed; a failed install goes back to the old commit", async () => {
    let installs = 0;
    const answers = base({
      "git diff --name-only aaa111": "package-lock.json\nsrc/x.js\n",
      "npm install": () => { installs++; if (installs === 1) throw new Error("ERESOLVE"); return ""; },
    });
    const { r, calls, text, restarted } = await run(answers);
    expect(r.ok).toBe(false);
    expect(calls).toContain("git reset --hard aaa111");
    expect(installs).toBe(2);                     // again on the old commit
    expect(text).toMatch(/ERESOLVE/);
    expect(restarted).toBe(false);
  });

  it("npm install: global install of the latest", async () => {
    const { exec, calls } = fakeExec({});
    let restarted = false;
    const r = await runUpdate({ root: dir, kind: "npm", current: "1.11.0", latest: "1.12.0", exec, log: () => {}, restart: () => { restarted = true; }, readChangelog: () => "" });
    expect(r.ok).toBe(true);
    expect(calls).toContain("npm install -g flint-agent@latest");
    expect(restarted).toBe(true);
  });

  it("a copied folder: says how to update by hand", async () => {
    const lines = [];
    const r = await runUpdate({ root: dir, kind: "none", current: "1.11.0", exec: () => "", log: (l) => lines.push(l), restart: () => {}, readChangelog: () => "" });
    expect(r.ok).toBe(false);
    expect(lines.join("\n")).toMatch(/git clone|npm i/);
    expect(existsSync(path.join(dir, ".git"))).toBe(false);
  });
});
