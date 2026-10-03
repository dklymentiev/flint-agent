// Self-update: Flint says when a newer version exists, and /update installs
// it on request (docs/self-update.md). It never updates on its own.
//
// Owner, 2026-10-02: "if ten people use it and we release a version, will
// they be able to update easily?" They learnt of a release only if told, and
// updated by hand.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const DAY = 24 * 3600 * 1000;
export const NPM_LATEST_URL = "https://registry.npmjs.org/flint-agent/latest";

const parts = (v) => String(v || "").replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);

/** -1, 0 or 1, comparing dotted versions as numbers. */
export function compareVersions(a, b) {
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** The newest vX.Y.Z among the lines of `git tag`, without the v; or null. */
export function latestTag(text) {
  const versions = String(text || "").split(/\r?\n/).map((l) => l.trim()).filter((l) => /^v\d+\.\d+\.\d+$/.test(l)).map((l) => l.slice(1));
  if (!versions.length) return null;
  return versions.sort(compareVersions).at(-1);
}

/** How this copy was installed: git (a clone), npm (a package) or none. */
export function installKind(root, { exists = existsSync } = {}) {
  if (exists(path.join(root, ".git"))) return "git";
  if (root.split(/[\\/]/).includes("node_modules")) return "npm";
  return "none";
}

/** Run a command in `root`; stdout, or a throw. Never waits for a password. */
export function defaultExec(root, timeout = 120000) {
  return (cmd, args = []) => execFileSync(cmd, args, {
    cwd: root,
    encoding: "utf8",
    timeout,
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32" && cmd === "npm",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
}

async function defaultFetchJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
  return r.ok ? r.json() : null;
}

/**
 * The newest version and whether it is newer than `current`, or null when
 * it could not be found out. At most one real check a day (`cacheFile`).
 */
export async function checkForUpdate({ root, current, kind, now = Date.now(), cacheFile, exec = defaultExec(root, 15000), fetchJson = defaultFetchJson }) {
  let latest = null;
  try {
    const c = cacheFile && existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, "utf8")) : null;
    if (c && c.kind === kind && now - c.checkedAt < DAY && c.latest) latest = c.latest;
  } catch {}
  if (!latest) {
    try {
      if (kind === "git") {
        exec("git", ["fetch", "--tags", "--quiet", "origin"]);
        latest = latestTag(exec("git", ["tag", "-l", "v*"]));
      } else {
        latest = (await fetchJson(NPM_LATEST_URL))?.version || null;
      }
    } catch {
      return null;
    }
    if (!latest) return null;
    try {
      if (cacheFile) {
        mkdirSync(path.dirname(cacheFile), { recursive: true });
        writeFileSync(cacheFile, JSON.stringify({ checkedAt: now, kind, latest }) + "\n");
      }
    } catch {}
  }
  return { current, latest, newer: compareVersions(latest, current) > 0 };
}

/** The line shown when a newer version exists, or null. */
export function updateNotice(check) {
  if (!check?.newer) return null;
  return `Flint ${check.latest} is out (you have ${check.current}). /update installs it.`;
}

/** The CHANGELOG sections newer than `from`, up to and including `to`. */
export function changelogBetween(text, from, to) {
  const out = [];
  let keep = false;
  for (const line of String(text || "").split(/\r?\n/)) {
    const h = line.match(/^## \[(\d+\.\d+\.\d+)\]/);
    if (h) keep = compareVersions(h[1], from) > 0 && compareVersions(h[1], to) <= 0;
    if (keep) out.push(line);
  }
  return out.join("\n").trim();
}

/**
 * Update this copy and restart. Refuses, changing nothing, when that would
 * overwrite someone's work. Returns { ok, updated?, latest?, reason? }.
 */
export async function runUpdate({ root, kind, current, latest, exec = defaultExec(root), log, restart, readChangelog }) {
  if (kind === "npm") {
    log(`Installing the latest flint-agent from npm (you have ${current})...`);
    try {
      exec("npm", ["install", "-g", "flint-agent@latest"]);
    } catch (err) {
      log(`The install failed, nothing changed: ${firstLine(err)}`);
      return { ok: false, reason: "npm install failed" };
    }
    log(latest ? `Installed ${latest}. Restarting, same session.` : "Installed. Restarting, same session.");
    restart();
    return { ok: true, updated: true, latest };
  }
  if (kind !== "git") {
    log("This copy was not installed with git or npm, so it cannot update itself.");
    log("Update by hand: `git clone https://github.com/dklymentiev/flint-agent.git` (then `npm install`), or `npm i -g flint-agent`.");
    return { ok: false, reason: "unknown install" };
  }

  // Never over someone's work. package-lock.json alone is not: npm rewrites it
  // on every install, two npm versions write it differently, and this very
  // command runs npm install, so without this every second /update refused.
  // It goes back to the committed lock, and npm install below follows it.
  const status = exec("git", ["status", "--porcelain", "--untracked-files=no"]);
  let dirty = status.trim();
  let lockRestored = false;
  // Paths start at column 4 ("XY path"); a trim first would eat the X column.
  const paths = status.split(/\r?\n/).filter((l) => l.trim()).map((l) => l.slice(3).trim());
  if (paths.length && paths.every((p) => p === "package-lock.json")) {
    exec("git", ["checkout", "--", "package-lock.json"]);
    dirty = "";
    lockRestored = true;
  }
  if (dirty) {
    log("Not updating: this checkout has changes of your own, and an update must not overwrite them:");
    for (const l of dirty.split("\n").slice(0, 10)) log(`  ${l}`);
    log("Commit or stash them, then /update again.");
    return { ok: false, reason: "local changes" };
  }
  const branch = exec("git", ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  if (branch !== "master") {
    log(`Not updating: the checkout is on branch ${branch}, and updates come to master. Switch to master to update.`);
    return { ok: false, reason: "not on master" };
  }
  const before = exec("git", ["rev-parse", "HEAD"]).trim();

  try {
    exec("git", ["fetch", "--tags", "origin"]);
  } catch (err) {
    log(`Could not reach the repository: ${firstLine(err)}`);
    return { ok: false, reason: "fetch failed" };
  }
  const newest = latestTag(exec("git", ["tag", "-l", "v*"]));
  if (!newest || compareVersions(newest, current) <= 0) {
    log(`Flint ${current} is the latest version.`);
    return { ok: true, updated: false, latest: newest || current };
  }

  log(`Updating Flint ${current} -> ${newest}.`);
  try {
    const changes = changelogBetween(readChangelog ? readChangelog() : exec("git", ["show", "origin/master:CHANGELOG.md"]), current, newest);
    if (changes) for (const l of changes.split("\n").slice(0, 40)) log(`  ${l}`);
  } catch {}

  try {
    exec("git", ["merge", "--ff-only", "origin/master"]);
  } catch (err) {
    log(`Not updating: master here and the repository's master have gone different ways, so this cannot fast-forward (${firstLine(err)}). Nothing changed.`);
    return { ok: false, reason: "cannot fast-forward" };
  }

  const changed = exec("git", ["diff", "--name-only", before, "HEAD"]).split(/\r?\n/);
  if (lockRestored || changed.some((f) => f === "package.json" || f === "package-lock.json")) {
    log("Installing the new dependencies...");
    try {
      exec("npm", ["install", "--no-audit", "--no-fund"]);
    } catch (err) {
      log(`npm install failed: ${firstLine(err)}`);
      log(`Going back to the version that worked (${current}).`);
      try { exec("git", ["reset", "--hard", before]); } catch {}
      try { exec("npm", ["install", "--no-audit", "--no-fund"]); } catch {}
      return { ok: false, reason: "npm install failed" };
    }
  }

  log(`Updated to ${newest}. Restarting, same session.`);
  restart();
  return { ok: true, updated: true, latest: newest };
}

function firstLine(err) {
  return String(err?.stderr || err?.message || err).split("\n").find((l) => l.trim()) || "unknown error";
}
