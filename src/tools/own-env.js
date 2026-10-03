// Flint's own writable environment: a Python venv and an npm prefix that the
// shell tools put first on PATH.
//
// WHY: when a task needs a library Flint does not have (read a PDF, speak a
// line), the model does the right thing and installs one. On 2026-09-27 in the
// bench box every such install failed: python3 and pip3 on PATH were another
// program's venv owned by root, the system python had no pip, npm -g pointed at
// /usr/local. E-docs-003 took 24 calls, most of them pip, npm and apt attempts
// refused one after another. A user's machine can be the same: a managed
// python, a read-only global prefix. So Flint brings a place it may write to,
// and pip / npm -g land there without the model having to know it exists.
//
// It lives next to ~/.flint/plugins, not in FLINT_DATA_DIR: what was installed
// is the user's tooling, shared by every session, like the plugins.
//
// If no python can make a venv, the shell tools run with the PATH they had and
// the reason is logged: nothing is pretended.

import { existsSync, mkdirSync } from "node:fs";
import { join, delimiter } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { createLogger } from "../logging/logger.js";

const log = createLogger("own-env");
const isWin = process.platform === "win32";

export function ownEnvPaths(dir = process.env.FLINT_ENV_DIR || join(homedir(), ".flint", "env")) {
  const venv = join(dir, "py");
  const npmPrefix = join(dir, "npm");
  return {
    dir,
    venv,
    venvBin: join(venv, isWin ? "Scripts" : "bin"),
    venvPython: join(venv, isWin ? "Scripts" : "bin", isWin ? "python.exe" : "python"),
    npmPrefix,
    // npm puts global bins in <prefix> on Windows and <prefix>/bin elsewhere,
    // and global modules in <prefix>/node_modules vs <prefix>/lib/node_modules.
    npmBin: isWin ? npmPrefix : join(npmPrefix, "bin"),
    npmModules: isWin ? join(npmPrefix, "node_modules") : join(npmPrefix, "lib", "node_modules"),
  };
}

function run(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    let err = "";
    let child;
    try {
      child = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    } catch (e) {
      resolve({ ok: false, err: e.message });
      return;
    }
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, timeoutMs);
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => { clearTimeout(timer); resolve({ ok: false, err: e.message }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ ok: code === 0, err: err.trim().slice(-300) }); });
  });
}

// On Windows, the first real python of that name on PATH, skipping the Store's
// App Execution Alias stubs in ...\Microsoft\WindowsApps. Spawned from a process
// that sits in a job object (seen under the vitest pool on 2026-09-28) the stub
// printed "AssignProcessToJobObject: (87)" and took the PARENT down with it,
// not just its own call: a Flint under a supervisor would die on its first
// shell command. Elsewhere the bare name is fine.
function resolvePython(name) {
  if (!isWin) return name;
  for (const d of (process.env.PATH || "").split(delimiter)) {
    if (!d || /[\\/]Microsoft[\\/]WindowsApps[\\/]?$/i.test(d)) continue;
    const exe = join(d, `${name}.exe`);
    if (existsSync(exe)) return exe;
  }
  return null;
}

// FLINT_OWN_ENV=0 turns it off. The test configs set it: otherwise every
// test that runs a shell command made a venv in the developer's real
// ~/.flint/env and waited seconds for it, and the suite went flaky on
// timeouts (2026-09-28). The own-env test turns it back on in a temp dir.
function ownEnvOff() {
  return process.env.FLINT_OWN_ENV === "0";
}

// One promise per env dir: the first shell command and the boot warm-up share it.
const pending = new Map();

/**
 * Make the venv and the npm prefix if they are not there yet. Never throws.
 * @returns {Promise<{python: boolean, reason?: string}>}
 */
export function ensureOwnEnv(paths = ownEnvPaths()) {
  if (ownEnvOff()) return Promise.resolve({ python: false, reason: "FLINT_OWN_ENV=0" });
  if (!pending.has(paths.dir)) pending.set(paths.dir, create(paths));
  return pending.get(paths.dir);
}

async function create(paths) {
  try { mkdirSync(paths.npmModules, { recursive: true }); } catch {}
  if (!isWin) { try { mkdirSync(paths.npmBin, { recursive: true }); } catch {} }
  if (existsSync(paths.venvPython)) return { python: true };

  // "python3" first: on Linux "python" may be absent or Python 2.
  const candidates = [process.env.FLINT_PYTHON, ...["python3", "python"].map(resolvePython)].filter(Boolean);
  const reasons = [];
  for (const py of candidates) {
    const r = await run(py, ["-m", "venv", paths.venv], 120000);
    if (r.ok && existsSync(paths.venvPython)) {
      log.info("own venv created", { python: py, venv: paths.venv });
      return { python: true };
    }
    reasons.push(`${py}: ${r.err || "no venv made"}`);
  }
  const reason = reasons.join("; ");
  log.warn("own venv not created; pip installs go wherever the system python points", { reason });
  return { python: false, reason };
}

/**
 * The environment a shell command runs with, with Flint's own env first.
 * Pure: reads the disk for what exists, changes nothing.
 */
export function withOwnEnv(env, paths = ownEnvPaths()) {
  if (ownEnvOff()) return { ...env };
  const out = { ...env };
  const front = [];
  if (existsSync(paths.venvPython)) {
    front.push(paths.venvBin);
    out.VIRTUAL_ENV = paths.venv;
  }
  front.push(paths.npmBin);
  out.NPM_CONFIG_PREFIX = paths.npmPrefix;
  out.NODE_PATH = [paths.npmModules, env.NODE_PATH].filter(Boolean).join(delimiter);
  out.PATH = [...front, env.PATH].filter(Boolean).join(delimiter);
  return out;
}
