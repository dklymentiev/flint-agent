// No test may write outside its own temp place.
//
// The failure this exists for is silent by construction: .permissions.json is in
// .gitignore (line 4), so a suite that overwrote the developer's saved
// permissions left `git status` clean. It was found by a container check that
// diffed the work tree, not by any test.
//
// The cause was narrow and is now fixed in src/config.js: the permission file's
// location was derived from config.projectRoot, which resolves from __dirname
// and so no env var could move it. Only the WRITABLE file is redirected under a
// test run (config.permissionsFile). projectRoot keeps its real value, because
// profiles.js, memory/store.js and bus/plugins.js read their directories from it
// at module load — redirecting it would give every one of those tests an empty
// sandbox and a green board over nothing.
//
// The assertions are on the REAL CHECKOUT, derived from this file's own location
// and never from config.projectRoot, which is the thing whose behaviour is in
// question. Each one is written to hold whether or not the developer running it
// has a .permissions.json of their own: "absent" is not the property, "exactly
// as it was" is.

import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { config } from "../../../src/config.js";
import { saveOnboardingAnswer, resetPermissionState, getOnboardingAnswer } from "../../../src/tools/permissions.js";

// tests/unit/tools/no-foreign-writes.test.js -> three levels up is the checkout.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const REPO_PERMISSIONS = path.join(REPO_ROOT, ".permissions.json");

/** name -> "size:mtime", for everything directly in a folder. */
function snapshot(dir) {
  const out = new Map();
  for (const name of readdirSync(dir)) {
    try {
      const s = statSync(path.join(dir, name));
      out.set(name, `${s.size}:${s.mtimeMs}`);
    } catch {
      out.set(name, "unstatable");
    }
  }
  return out;
}

/** "absent" or the exact bytes of a file, so "unchanged" is decidable. */
function fingerprint(file) {
  if (!existsSync(file)) return "absent";
  return readFileSync(file, "utf8");
}

// Taken at import, before any test in this file can write anything.
const BEFORE = snapshot(REPO_ROOT);
const PERMISSIONS_BEFORE = fingerprint(REPO_PERMISSIONS);

describe("a test run leaves the checkout exactly as it found it", () => {
  it("left .permissions.json in the checkout byte-for-byte as it was", () => {
    // The file the suites write on every run. It holds the developer's own
    // saved permissions, the onboarding answer and per-file "[a]lways"
    // approvals — so overwriting it does not just add a file, it discards
    // decisions somebody made.
    //
    // Asserted as "unchanged" rather than "absent": a developer who has run
    // Flint has one, and a test that demanded it be missing would fail for
    // them while passing for everyone else.
    expect(
      fingerprint(REPO_PERMISSIONS),
      ".permissions.json in the checkout was rewritten by the test run",
    ).toBe(PERMISSIONS_BEFORE);
  });

  it("added no file to the checkout while the suite ran", () => {
    // The general form, so the next module that gets this wrong is caught even
    // if nobody thinks to name its file here.
    const added = [...snapshot(REPO_ROOT).keys()].filter((n) => !BEFORE.has(n));
    expect(added, `these files appeared in the checkout: ${added.join(", ")}`).toEqual([]);
  });

  it("did not rewrite a file that was already there", () => {
    // Creation is not the only way to be destructive: overwriting an existing
    // file leaves the same name behind, so a name-only check passes while the
    // contents changed. node_modules and .git are excluded — npm and git write
    // there legitimately, and a suite run may legitimately invoke both.
    const now = snapshot(REPO_ROOT);
    const changed = [];
    for (const [name, stamp] of BEFORE) {
      if (name === "node_modules" || name === ".git") continue;
      const after = now.get(name);
      if (after && after !== stamp) changed.push(name);
    }
    expect(changed, `these files were modified during the run: ${changed.join(", ")}`).toEqual([]);
  });

  it("writes the permission file into temp, not into the checkout", () => {
    // The mechanism, asserted so the next run of this suite is not the thing
    // that discovers it again.
    expect(
      path.resolve(config.permissionsFile),
      `config.permissionsFile resolved to the checkout: ${config.permissionsFile}`,
    ).not.toBe(path.resolve(REPO_PERMISSIONS));
    expect(
      path.resolve(config.permissionsFile).startsWith(path.resolve(tmpdir())),
      `config.permissionsFile ("${config.permissionsFile}") is not inside the OS temp dir, so a test write lands in the checkout`,
    ).toBe(true);
  });

  it("deliberately does not redirect projectRoot", () => {
    // The other half, and the reason the fix is narrow.
    //
    // Moving projectRoot was tried first and reverted: profiles.js,
    // memory/store.js and bus/plugins.js resolve their directories from it at
    // module load, so a redirected root would give those tests no profiles, no
    // memories and no plugins, and they would pass against an empty sandbox.
    // Only the one writable file is redirected.
    expect(
      path.resolve(config.projectRoot),
      `config.projectRoot is "${config.projectRoot}" — it must stay the real checkout so tests read real resources`,
    ).toBe(path.resolve(REPO_ROOT));
  });

  it("still persists permissions — into the temp place", () => {
    // Otherwise "tests write nothing" is a rule satisfied only by a broken
    // persistence layer, and the obvious way to earn a green board would be to
    // stop saving anything at all. This drives the real product path and
    // asserts the bytes arrived in the sandbox and the checkout is untouched.
    const before = fingerprint(REPO_PERMISSIONS);
    // Start from no file: the sandbox file is shared by the whole run, and if
    // another test had already saved "safe" there, a correct save wrote the
    // same bytes and "the file changed" failed (GitHub Actions, 2026-10-02).
    rmSync(config.permissionsFile, { force: true });
    try {
      resetPermissionState();
      saveOnboardingAnswer("safe");
      expect(getOnboardingAnswer(), "the save did not take effect in memory").toBe("safe");
      expect(
        existsSync(config.permissionsFile) && JSON.parse(readFileSync(config.permissionsFile, "utf8")).onboardingAnswer,
        "saving a permission wrote nothing — persistence is broken, not merely redirected",
      ).toBe("safe");
    } finally {
      resetPermissionState();
    }
    expect(
      fingerprint(REPO_PERMISSIONS),
      "saving a permission wrote into the checkout",
    ).toBe(before);
  });
});

// No afterAll cleanup, deliberately.
//
// An earlier version of this file removed config.permissionsFile's directory
// "to leave no debris", and that broke a test in another file: the sandbox is
// SHARED by every test in the run, not private to this one. command-approvals.js
// binds FILE at module load and _resetForTest() drops its cache, so the next
// getCommandApproval re-reads the file from disk — and found it gone.
// `gap 4: [a]lways on a command prompt is kept per project > survives a restart`
// failed in a full unit run and passed 3/3 on its own: an ordering dependency
// this file introduced, depending on a file on disk that was still being
// written to by the rest of the suite.
//
// A test that tidies up after itself by deleting a shared resource is not being
// careful, it is reaching into state it does not own. The sandbox is in the OS
// temp dir and Vitest's own tmpdir handling disposes of it.
