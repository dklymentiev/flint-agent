import { spawn, execFileSync } from "node:child_process";
import { wrapCommand, getSandboxMode } from "../sandbox/backend.js";
import { ensureOwnEnv, withOwnEnv } from "./own-env.js";
import path from "node:path";
import os from "node:os";
import { config } from "../config.js";
import { lastOutputLine } from "../ui/last-line.js";
import {
  printProcessEnd, printProcessSummary,
} from "../ui/output.js";


// ── Child process registry for graceful shutdown ──
export const activeChildren = new Map(); // procId → ChildProcess

/**
 * Check a shell command against the AGENT_ALLOWED_PATHS radius.
 * Returns an error string if the cwd or any literal path in the command
 * is outside the allowed directories, or null if the command is allowed.
 *
 * This is the single shared check used by both run_command and
 * run_background_command — delete this function's call site and both
 * handlers go unguarded.
 *
 * The radius is not complete: paths assembled from shell variables ($VAR),
 * command substitution ($(cmd), backticks), or glob patterns are not
 * visible. For real isolation use a container or a dedicated OS user.
 */

/**
 * Normalise a path for comparison: resolve to absolute, convert backslashes
 * to forward slashes, and lowercase on Windows (where the filesystem is
 * case-insensitive for drive and directory names). On Linux the comparison
 * stays case-sensitive.
 *
 * This exists because startsWith("C:\\Projects", "c:/projects") returns
 * false on Windows even though they are the same directory — the drive letter
 * case and the slash direction differ, and Windows treats both the drive
 * letter and the directory components as case-insensitive.
 */
function normalisePathForCompare(p) {
  const resolved = path.resolve(p).replace(/\\/g, "/");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * True when `target` is the same as or inside `dir`, on every platform.
 * Both arguments are normalised (see normalisePathForCompare) before
 * comparison, so on Windows "C:\\Projects" and "c:/projects" match.
 */
function pathIsInside(target, dir) {
  const normTarget = normalisePathForCompare(target);
  const normDir = normalisePathForCompare(dir);
  return normTarget === normDir || normTarget.startsWith(normDir.endsWith("/") ? normDir : normDir + "/");
}

export { pathIsInside };

export function checkShellPathRadius(command, cwd) {
  if (!config.allowedPaths?.length) return null;

  const ok = config.allowedPaths.some((dir) => pathIsInside(cwd, dir));
  if (!ok) return `Error: working directory "${cwd}" is outside allowed paths`;

  const cmdPaths = extractCommandPaths(command, cwd);
  for (const p of cmdPaths) {
    const resolved = path.resolve(p);
    const inside = config.allowedPaths.some((dir) => pathIsInside(resolved, dir));
    if (!inside) {
      return `Error: command references path "${resolved}" outside allowed paths [${config.allowedPaths.join(", ")}]`;
    }
  }
  return null;
}

export function extractCommandPaths(cmd, cwd) {
  const results = [];
  const allowed = [];
  const dollarSign = String.fromCharCode(36);

  const tokens = [];
  {
    const SEP = /[\s]/;
    let i = 0;
    while (i < cmd.length) {
      const ch = cmd[i];
      if (SEP.test(ch)) { i++; continue; }
      const metaMatch = cmd.slice(i).match(/^(&&|\|\||;|\|)/);
      if (metaMatch) {
        tokens.push({ raw: metaMatch[1], op: true });
        i += metaMatch[1].length;
        continue;
      }
      if (ch === '>') {
        const isAppend = cmd[i + 1] === '>';
        tokens.push({ raw: isAppend ? ">>" : ">", op: true });
        i += isAppend ? 2 : 1;
        continue;
      }
      if (ch === '<') {
        tokens.push({ raw: "<", op: true });
        i++;
        continue;
      }
      if ((ch === '2' || ch === '1') && cmd[i + 1] === '>') {
        i += 2;
        continue;
      }
      if (ch === '"' || ch === "'") {
        const q = ch;
        let j = i + 1;
        let buf = "";
        while (j < cmd.length && cmd[j] !== q) {
          // In single quotes, backslash is literal (bash behavior).
          // In double quotes, backslash escapes the next char.
          if (ch === '"' && cmd[j] === '\\' && j + 1 < cmd.length) { buf += cmd[j + 1]; j += 2; }
          else { buf += cmd[j]; j++; }
        }
        if (j < cmd.length) j++;
        tokens.push({ raw: buf, quoted: true });
        i = j;
        continue;
      }
      // Variable references: $VAR, ${VAR}, $(cmd) — read the whole thing
      // as one token and skip it (the radius can't resolve dynamic paths).
      if (ch === dollarSign) {
        let j = i + 1;
        if (cmd[j] === "{") {
          // ${...}
          j++;
          while (j < cmd.length && cmd[j] !== "}") j++;
          if (j < cmd.length) j++;
        } else {
          // $VARNAME
          while (j < cmd.length && /[a-zA-Z_]/.test(cmd[j])) j++;
        }
        if (j > i) { i = j; continue; }
        i++; // lone $
        continue;
      }
      // Unquoted token — read until whitespace, metachar, >, <, or $
      let j = i;
      let buf = "";
      while (j < cmd.length && !SEP.test(cmd[j])
        && !/^(&&|\|\||;|\|)/.test(cmd.slice(j))
        && cmd[j] !== '>' && cmd[j] !== '<' && cmd[j] !== dollarSign) {
        buf += cmd[j]; j++;
      }
      if (buf.length > 0) tokens.push({ raw: buf, quoted: false });
      i = j;
    }
  }

  for (let idx = 0; idx < tokens.length; idx++) {
    const tok = tokens[idx];
    if (!tok.quoted || tok.raw.length < 2) continue;
    const prev = tokens[idx - 1];
    const prev2 = tokens[idx - 2];
    if (prev && prev.raw === "-c" && prev2 && prev2.raw) {
      if (/^(bash|sh)$/.test(prev2.raw) || prev2.raw.includes("/bin/")) {
        const nested = extractCommandPaths(tok.raw, cwd);
        for (const p of nested) {
          if (results.indexOf(p) === -1) results.push(p);
        }
        tokens.splice(idx - 2, 2);
      }
    }
  }

  const pathLikeRe = /^(\/|~|[a-zA-Z]:[\\/])|(\/\.\/|\.\.\\|\.\/|\.\.\/)/;

  let prevOp = null;

  for (let idx = 0; idx < tokens.length; idx++) {
    const tok = tokens[idx];
    const raw = tok.raw;

    if (!raw) continue;
    if (/\$\{?/.test(raw) || raw.includes("`")) continue;
    if (raw.includes("*") || raw.includes("?")) continue;

    if (tok.op && (raw === ">" || raw === ">>" || raw === "<")) {
      prevOp = raw;
      continue;
    }
    if (prevOp) {
      allowed.push(raw);
      prevOp = null;
      continue;
    }

    if (tok.op) continue;

    if (pathLikeRe.test(raw)) {
      allowed.push(raw);
      continue;
    }
  }

  for (const raw of allowed) {
    let resolved;
    if (/^\/c\//i.test(raw) || /^\/[a-zA-Z]\//.test(raw)) {
      resolved = raw.replace(/^\/c\//i, "C:\\").replace(/^\/([a-zA-Z])\//, "$1:\\").replace(/\//g, "\\");
    } else if (raw === "/tmp" || raw.startsWith("/tmp/")) {
      // join, not resolve: slice(4) leaves a leading "/" and resolve() would treat it as absolute,
      // turning /tmp/x into /x on Linux, where os.tmpdir() is /tmp itself.
      resolved = path.join(os.tmpdir(), raw.slice(4));
    } else if (path.isAbsolute(raw)) {
      resolved = path.resolve(raw);
    } else {
      resolved = path.resolve(cwd, raw);
    }
    if (results.indexOf(resolved) === -1) results.push(resolved);
  }

  return results;
}

// First process id of the batch running now (see run_background_command).
let batchFrom = null;

// R0: abort signal propagation from agent loop to child processes
let _currentAbortSignal = null;
export function setProcessAbortSignal(signal) { _currentAbortSignal = signal; }
export function getProcessAbortSignal() { return _currentAbortSignal; }

// Global rate limit for background process chat output (1 line per 5s across ALL processes)
let _lastGlobalChatLine = 0;
const _GLOBAL_CHAT_INTERVAL = 5000;

/**
 * Signal a process and everything under it, on Unix. SIGTERM to the shell
 * alone leaves its commands running: `sleep 45; echo` kept going after the
 * turn was stopped, held the output pipe open, and the stop waited for it
 * (Linux, 2026-10-02). Children are found through ps and signalled before
 * their parent, deepest first, so none is re-parented out of reach.
 */
export function killUnixTree(pid, sig = "SIGTERM") {
  if (!pid) return;
  let rows = [];
  try {
    rows = execFileSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8", timeout: 5000 })
      .trim().split("\n").map((l) => l.trim().split(/\s+/).map(Number));
  } catch {
    // Fallback: read /proc to find process tree. Some minimal containers
    // lack a `ps` that supports -A (e.g. busybox ps). The /proc approach
    // is slower but always available on Linux.
    try {
      for (const entry of require("fs").readdirSync("/proc")) {
        const n = Number(entry);
        if (!Number.isNaN(n) && n > 0) {
          let state = "";
          try { state = require("fs").readFileSync(`/proc/${n}/stat`, "utf8"); } catch {}
          const parts = state.split(/\s+/);
          if (parts.length >= 4) {
            const ppid = Number(parts[3]);
            if (!Number.isNaN(ppid)) rows.push([n, ppid]);
          }
        }
      }
    } catch {}
  }
  const kids = new Map();
  for (const [p, pp] of rows) {
    if (!kids.has(pp)) kids.set(pp, []);
    kids.get(pp).push(p);
  }
  const order = [];
  const walk = (p) => { for (const c of kids.get(p) || []) { walk(c); order.push(c); } };
  walk(pid);
  order.push(pid);
  for (const p of order) { try { process.kill(p, sig); } catch {} }
}

export function killAllChildren(timeoutMs = 3000) {
  const running = [...activeChildren.entries()];
  if (!running.length) return;

  for (const [id, child] of running) {
    try {
      // Windows: taskkill /PID /T kills process tree
      if (process.platform === "win32" && child.pid) {
        spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      } else {
        killUnixTree(child.pid);
      }
    } catch {}
  }

  // Force kill after timeout
  setTimeout(() => {
    for (const [id, child] of activeChildren) {
      try { child.kill("SIGKILL"); } catch {}
    }
    activeChildren.clear();
  }, timeoutMs);
}

/**
 * Kill every background process and its children now, before returning. For
 * a process about to exit: killAllChildren's taskkill is spawned and not
 * waited for, so an exit right after it left grandchildren running (a
 * `ping -n 40` outlived the stdio-mode test that started it, 2026-10-02).
 */
export function killAllChildrenSync() {
  for (const [, child] of activeChildren) {
    if (!child?.pid) continue;
    try {
      if (process.platform === "win32") {
        execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", timeout: 5000 });
      } else {
        killUnixTree(child.pid);
      }
    } catch {}
  }
  activeChildren.clear();
}

export function fmtElapsed(ms) {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const s = sec % 60;
  return `${min}m ${s}s`;
}

// ── Tool definitions ──

export const processToolDefs = [
  {
    type: "function",
    function: {
      name: "run_command",
      description: "Execute a shell command and return its output. Use for git, npm, python, etc.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The shell command to execute" },
          timeout_seconds: { type: "number", description: "Kill the command after this many seconds (default 120, max 600). Raise it for test suites and builds." },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_background_command",
      description: "Run a long-running shell command in the background. Returns immediately with a process ID. Output is kept for peek_process and the operator's /logs <id>; it is not printed into the chat. Use for: npm test, builds, servers, training, etc.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The shell command to execute in background" },
          label: { type: "string", description: "Short label for the process (optional)" },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "kill_process",
      description: "Kill a background process. Pass either the process ID (small number like 1, 2, 3 from list_processes) or the system PID. Use list_processes first to see IDs.",
      parameters: {
        type: "object",
        properties: {
          process_id: { type: "number", description: "The process ID (1, 2, 3...) from list_processes output — NOT the system PID" },
        },
        required: ["process_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_processes",
      description: "List all background processes with their status, PID, and last output line.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "peek_process",
      description: "Read the last N lines of output from a background process. Use to check progress.",
      parameters: {
        type: "object",
        properties: {
          process_id: { type: "number", description: "Process ID from list_processes" },
          lines: { type: "number", description: "Number of lines to return (default: 10, max: 50)" },
        },
        required: ["process_id"],
      },
    },
  },
];

// ── Handler implementations ──

export function createProcessHandlers(store) {
  return {
    async kill_process({ process_id }) {
      const id = Number(process_id);
      // Try finding by process ID first, then fallback to PID
      let proc = store.getState().processes.find((p) => p.id === id);
      if (!proc) {
        proc = store.getState().processes.find((p) => p.pid === id);
      }
      if (!proc) {
        const all = store.getState().processes.map((p) => `[${p.id}] pid:${p.pid} ${p.cmd}`).join("\n");
        return `Process ${id} not found. Available:\n${all || "(none)"}`;
      }
      if (proc.status !== "running") return `Process ${proc.id} (${proc.cmd}) is already ${proc.status}.`;
      const actualId = proc.id;

      // Kill via activeChildren map (has actual ChildProcess reference)
      const child = activeChildren.get(actualId);
      if (child) {
        try {
          if (process.platform === "win32") {
            spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
          } else {
            killUnixTree(child.pid);
          }
        } catch {}
        activeChildren.delete(actualId);
      } else {
        // Fallback: kill by PID from store
        store.getState().killProcess(actualId);
      }
      store.getState().finishProcess(actualId, null, "killed");
      return `Killed process ${actualId} (${proc.cmd}), pid ${proc.pid}.`;
    },

    async list_processes() {
      const procs = store.getState().processes;
      if (!procs.length) return "No background processes.";
      const lines = ["ID | Status  | PID   | Time   | Command"];
      for (const p of procs) {
        const elapsed = fmtElapsed(Date.now() - p.startTime);
        const last = p.output.length > 0 ? p.output[p.output.length - 1] : "";
        const lastShort = last.length > 60 ? last.slice(0, 60) + "..." : last;
        lines.push(`${p.id}  | ${p.status.padEnd(7)} | ${String(p.pid).padEnd(5)} | ${elapsed.padEnd(6)} | ${p.cmd}`);
        if (lastShort) lines.push(`     \\ ${lastShort}`);
      }
      lines.push(`\nTo kill a process, use kill_process with the ID (first column), not the PID.`);
      return lines.join("\n");
    },

    async peek_process({ process_id, lines }) {
      const id = Number(process_id);
      const n = Math.min(50, Math.max(1, lines || 10));
      let proc = store.getState().processes.find((p) => p.id === id);
      if (!proc) proc = store.getState().processes.find((p) => p.pid === id);
      if (!proc) return `Process ${id} not found.`;
      const output = proc.output.slice(-n);
      if (!output.length) return `[${proc.cmd}] status: ${proc.status} | (no output yet)`;
      return `[${proc.cmd}] status: ${proc.status} | ${output.length} lines:\n${output.join("\n")}`;
    },

    async run_command({ command, cwd: requestedCwd, timeout_seconds: timeoutSeconds }) {
      // Enforce denied paths (e.g. during auto mode)
      const { getDeniedPaths } = await import("./filesystem.js");
      const denied = getDeniedPaths();

      // Normalize /tmp/ paths for cross-platform consistency
      const { normalizeTmpPath } = await import("./filesystem.js");
      if (requestedCwd) requestedCwd = normalizeTmpPath(requestedCwd);

      // Choose cwd: requested > auto-detect from command > projectRoot
      let cwd = requestedCwd || config.baseDir || config.projectRoot;
      // Auto-detect cwd for scripts outside projectRoot (e.g. /tmp/fcheck/bin/fcheck.js)
      if (!requestedCwd) {
        const scriptMatch = command.match(/node\s+["']?([^\s"']+)/);
        if (scriptMatch) {
          const scriptPath = normalizeTmpPath(scriptMatch[1]);
          if (path.isAbsolute(scriptPath) && !scriptPath.startsWith(config.baseDir || config.projectRoot)) {
            cwd = path.dirname(scriptPath);
          }
        }
      }
      if (denied.length) {
        const resolved = path.resolve(cwd);
        const inDenied = denied.some((dir) => resolved.startsWith(dir + path.sep) || resolved === dir);
        if (inDenied) {
          cwd = os.tmpdir();
        }
        // Also check if command references denied paths (prevent echo > src/file.js bypass)
        const cmdNorm = command.replace(/\\/g, "/").toLowerCase();
        for (const dir of denied) {
          const dirNorm = dir.replace(/\\/g, "/").toLowerCase();
          if (cmdNorm.includes(dirNorm)) {
            return `Error: command references protected directory "${dir}" (self-modification blocked)`;
          }
        }
      }

      // Enforce allowed paths for cwd and command text if configured
      const radiusError = checkShellPathRadius(command, cwd);
      if (radiusError) return radiusError;
      try {
        // Filter sensitive env vars — allowlist approach
        const safeEnv = {};
        const ENV_ALLOWLIST = ["PATH", "HOME", "USER", "LANG", "LC_ALL", "TZ", "TERM",
          "SHELL", "TMPDIR", "TEMP", "TMP", "NODE_ENV", "DISPLAY",
          "XDG_RUNTIME_DIR", "SYSTEMROOT", "COMSPEC", "WINDIR", "APPDATA",
          "PROGRAMFILES", "LOCALAPPDATA", "USERPROFILE", "HOMEDRIVE", "HOMEPATH"];
        for (const key of ENV_ALLOWLIST) {
          if (process.env[key]) safeEnv[key] = process.env[key];
        }
        // Ensure Git Bash core utils are in PATH (mv, cp, find, etc.)
        if (process.platform === "win32" && config.shell.includes("bash")) {
          const gitUsrBin = path.dirname(config.shell); // e.g. C:\Program Files\Git\usr\bin
          const gitMingw = path.resolve(gitUsrBin, "../../mingw64/bin");
          const pathSep = ";";
          const existing = safeEnv.PATH || "";
          if (!existing.includes(gitUsrBin)) {
            safeEnv.PATH = `${gitUsrBin}${pathSep}${gitMingw}${pathSep}${existing}`;
          }
        }
        // Flint's own venv and npm prefix first, so an install lands where
        // Flint may write (own-env.js). Host paths mean nothing inside the
        // docker sandbox, so only locally.
        if (getSandboxMode() !== "docker") {
          await ensureOwnEnv();
          Object.assign(safeEnv, withOwnEnv(safeEnv));
        }
        // Normalize /tmp/ in command for Windows (Git Bash /tmp/ != Node.js /tmp/)
        let normalizedCommand = command;
        if (process.platform === "win32") {
          const osTmp = os.tmpdir().replace(/\\/g, "/");
          // Replace /tmp/ with os.tmpdir() so bash finds files where write_file put them
          normalizedCommand = command.replace(/\/tmp\//g, osTmp + "/");
        }
        // Route through sandbox backend (local = direct spawn, docker = docker exec)
        const sandboxed = wrapCommand(normalizedCommand, cwd, { shell: config.shell, env: safeEnv });
        const shell = sandboxed.shell;
        const shellArgs = sandboxed.shellArgs;
        if (sandboxed.cwd) cwd = sandboxed.cwd;
        // In headless mode, background commands (`cmd &`) would be reparented
        // to init and orphaned when the shell exits, surviving the run. A
        // headless shell is therefore spawned in its own process group
        // (detached:true) and given a small EXIT trap that kills its own
        // background jobs — `kill $(jobs -p)` targets the `&` child by PID
        // rather than `kill 0`, so the shell itself is not signalled and keeps
        // a clean exit code. The 0.05s sleep lets the freshly-started job
        // report as a job before the trap fires; 20ms/0.3s were both tested
        // for reliability.
        //
        // The trap MUST NOT overwrite the command's real exit code: `exit 0`
        // at the end would discard it, making every failing command look
        // successful to the model. Instead the trap captures `$?` as its very
        // first action (before any command in the trap body can alter it) and
        // exits with that value. The `kill ... || true` guards against
        // `set -e` aborting the trap early when there are no background jobs
        // (kill returns non-zero), which would also lose the captured code.
        // Interactive runs get neither the trap nor detached:true, so an
        // operator's `server &` still survives shell exit and an operator's
        // own trap/exec is left untouched — normal command completion is
        // identical to master.
        const isHeadless = config.headless === true;
        if (shellArgs.length === 2 && shellArgs[0] === "-c" && isHeadless) {
          shellArgs[1] = "trap 'rc=$?; sleep 0.05; kill $(jobs -p) 2>/dev/null || true; exit $rc' EXIT; " + shellArgs[1];
        }
        const MAX_OUTPUT = 1024 * 1024; // 1 MB max output
        // 30s killed the project's own test suite (about 37s) on the
        // 2026-09-26 repair bench; the agent could not run its fix and
        // reverted it. Default 120s, and the model may ask for up to 600 when
        // it knows the command is long.
        const requested = Number(timeoutSeconds);
        const defaultSec = parseInt(process.env.AGENT_COMMAND_TIMEOUT || "120", 10);
        const COMMAND_TIMEOUT = Math.min(600, requested > 0 ? requested : defaultSec) * 1000;
        const result = await new Promise((resolve, reject) => {
          // R0 v2: we manage timeout ourselves (not via spawn timeout option)
          // because spawn's timeout sends signal via process.kill() which only
          // kills the parent shell, not the whole pipeline tree on Windows.
          const child = spawn(shell, shellArgs, {
            cwd,
            env: safeEnv,
            stdio: ["ignore", "pipe", "pipe"],
            // Headless only (see comment above): own process group so the
            // trap's `kill $(jobs -p)` reaches `&` children without taking
            // Flint itself down.
            detached: isHeadless,
          });
          activeChildren.set("run_cmd_" + child.pid, child);

          // Kill process tree (cross-platform)
          const killTree = () => {
            try {
              if (process.platform === "win32" && child.pid) {
                // /T = tree, /F = force — kills entire pipeline (bash + du + sort + head)
                spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
              } else {
                // The whole tree, then SIGKILL after a grace period for
                // anything that ignored SIGTERM.
                killUnixTree(child.pid);
                setTimeout(() => { killUnixTree(child.pid, "SIGKILL"); }, 3000);
              }
            } catch {}
          };

          // Hard timeout: kill tree after COMMAND_TIMEOUT (30s default)
          // plus safety resolve 5s later if stdio pipes remain open.
          let timedOut = false;
          let safetyResolveHandle = null;
          const timeoutHandle = setTimeout(() => {
            timedOut = true;
            killTree();
            // Safety resolve: if close event does not fire within 5s after kill
            // (e.g. because stdio pipes are held by a cat in the pipeline),
            // resolve the promise anyway so the caller does not hang.
            safetyResolveHandle = setTimeout(() => {
              try { child.stdout?.destroy(); } catch {}
              try { child.stderr?.destroy(); } catch {}
              activeChildren.delete("run_cmd_" + child.pid);
              resolve({
                code: -1,
                stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
                stderr: "[killed by timeout after " + COMMAND_TIMEOUT + "ms]",
                truncated: false,
                timedOut: true,
              });
            }, 5000);
          }, COMMAND_TIMEOUT);

          let totalSize = 0;
          const stdoutChunks = [];
          const stderrChunks = [];

          child.on("close", () => {
            clearTimeout(timeoutHandle);
            if (safetyResolveHandle) clearTimeout(safetyResolveHandle);
            activeChildren.delete("run_cmd_" + child.pid);
          });

          // R0 fix: propagate external abort signal to child process tree
          const signal = _currentAbortSignal;
          if (signal) {
            // When the abort signal fires during run_command (e.g. SIGTERM on
            // the headless process), killTree kills the child and its tree, but
            // the close event may never fire if a grandchild holds the stdio
            // pipes open (common on Linux: `bash -c "sleep 60"` forks sleep as
            // a child that keeps the pipes, and ps-based tree kill may miss it).
            // Without a resolve, run_command hangs and the agent loop never
            // sees signal.aborted, so the headless try/catch never saves the
            // session or prints JSON. Resolve immediately and destroy the pipes
            // so the close event (if it fires later) resolves to a no-op.
            const onAbort = () => {
              killTree();
              // Resolve immediately — do NOT defer via a safety timer. On POSIX,
              // the close event fires and its handler (above) clears any timer we
              // set, so a delayed resolve never runs and the promise hangs.
              // The close handler's resolve is a harmless no-op once we have
              // resolved. Destroying the stdio streams ensures the close event
              // still fires for the child's exit bookkeeping.
              try { child.stdout?.destroy(); } catch {}
              try { child.stderr?.destroy(); } catch {}
              // The child stays in activeChildren until its close event (above)
              // says it is gone. killTree on Windows is a taskkill that is
              // spawned and not waited for, and a run that is being stopped
              // exits within milliseconds of this abort: taken off the list
              // here, the command was out of killAllChildrenSync's reach and
              // outlived the run (--time-limit during a command, 2026-10-08).
              resolve({
                code: null,
                stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
                stderr: "[killed by external abort]",
                truncated: false,
                timedOut: false,
              });
            };
            if (signal.aborted) {
              onAbort();
            } else {
              signal.addEventListener("abort", onAbort, { once: true });
              child.on("close", () => {
                signal.removeEventListener("abort", onAbort);
              });
            }
          }

          const onData = (chunks) => (d) => {
            totalSize += d.length;
            if (totalSize > MAX_OUTPUT) {
              // RX-3.1: this call used to reference a non-existent hardKill()
              // which threw ReferenceError in a socket 'data' handler and
              // crashed the whole Flint process when any command exceeded
              // the 1 MB output cap (e.g. `tasklist` on a busy box).
              killTree();
              return;
            }
            chunks.push(d);
            showProgress(d);
          };
          // The latest output line on the activity row, at most 4 times a
          // second, so a long command shows progress and not only a clock.
          let lastShownAt = 0;
          const showProgress = (d) => {
            const now = Date.now();
            if (now - lastShownAt < 250) return;
            const line = lastOutputLine(d);
            if (!line) return;
            lastShownAt = now;
            store.getState().setActivityDetail?.(line);
          };
          child.stdout.on("data", onData(stdoutChunks));
          child.stderr.on("data", onData(stderrChunks));
          child.on("close", (code) => {
            store.getState().setActivityDetail?.(null);
            const truncated = totalSize > MAX_OUTPUT;
            // When the kill lands, the child closes with an ordinary exit
            // code (1 from taskkill on Windows) and this used to report it as
            // a plain failure: the model could not tell "the tests are slow"
            // from "the tests failed". The timeout is said in so many words.
            const stderr = Buffer.concat(stderrChunks).toString("utf-8");
            resolve({
              code,
              stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
              stderr: timedOut
                ? (stderr ? stderr + "\n" : "") + "[killed by timeout after " + COMMAND_TIMEOUT + "ms]"
                : stderr,
              truncated,
            });
          });
          child.on("error", reject);
        });
        if (result.truncated) return "Error: output exceeded 1 MB limit — process killed.";
        const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
        let output = stripAnsi(result.stdout || "");
        if (result.stderr) output += (output ? "\n" : "") + "STDERR: " + stripAnsi(result.stderr);
        if (result.code !== 0 && result.code !== null) {
          return `Error (exit ${result.code}): ${output || "(no output)"}`;
        }
        return output || "(no output)";
      } catch (err) {
        return `Error: ${err.message}`;
      }
    },

    async run_background_command({ command, label }) {
      // Limit concurrent background processes
      const MAX_BG = 5;
      const running = [...activeChildren.keys()];
      if (running.length >= MAX_BG) {
        return `Error: too many background processes (${running.length}/${MAX_BG}). Kill some first.`;
      }
      // The model's label names the process for the model (list_processes,
      // kill_process). The screen shows the command itself: the label ("ping302")
      // made the start line and the end line name one process two ways
      // (owner, 2026-10-01).
      const displayCmd = label || command;
      // A batch is the processes that ran at the same time; the summary counts
      // only those, not every process this session ever started.
      if (!store.getState().processes.some((p) => p.status === "running")) batchFrom = null;

      // Enforce allowed paths for cwd and command text (same as run_command)
      const bgCwd = config.baseDir || config.projectRoot;
      const bgRadiusError = checkShellPathRadius(command, bgCwd);
      if (bgRadiusError) return bgRadiusError;

      const shell = config.shell;
      const shellArgs = ["-c", command];

      // Allowlist env vars for child processes
      const bgEnv = {};
      const BG_ENV_ALLOW = ["PATH", "HOME", "USER", "LANG", "LC_ALL", "TZ", "TERM",
        "SHELL", "TMPDIR", "TEMP", "TMP", "NODE_ENV", "DISPLAY",
        "XDG_RUNTIME_DIR", "SYSTEMROOT", "COMSPEC", "WINDIR", "APPDATA",
        "PROGRAMFILES", "LOCALAPPDATA", "USERPROFILE", "HOMEDRIVE", "HOMEPATH"];
      for (const key of BG_ENV_ALLOW) {
        if (process.env[key]) bgEnv[key] = process.env[key];
      }
      // Ensure Git Bash core utils are in PATH
      if (process.platform === "win32" && config.shell.includes("bash")) {
        const gitUsrBin = path.dirname(config.shell);
        const gitMingw = path.resolve(gitUsrBin, "../../mingw64/bin");
        const existing = bgEnv.PATH || "";
        if (!existing.includes(gitUsrBin)) {
          bgEnv.PATH = `${gitUsrBin};${gitMingw};${existing}`;
        }
      }
      // Same own env as run_command: a server started here must see what was
      // installed there.
      await ensureOwnEnv();
      Object.assign(bgEnv, withOwnEnv(bgEnv));
      const BG_TIMEOUT = 5 * 60 * 1000; // 5 minutes max
      const BG_MAX_OUTPUT = 5 * 1024 * 1024; // 5 MB max output
      const child = spawn(shell, shellArgs, {
        cwd: config.baseDir || config.projectRoot,
        env: bgEnv,
        stdio: ["ignore", "pipe", "pipe"],
        detached: false,
      });

      const procId = store.getState().addProcess({
        cmd: displayCmd,
        command,
        pid: child.pid,
      });
      if (batchFrom == null) batchFrom = procId;

      // Track for graceful shutdown
      activeChildren.set(procId, child);

      // Register in TaskRegistry for Escape abort
      const taskRegId = store.getState().registerTask({
        type: "bg-process",
        label: displayCmd.length > 40 ? displayCmd.slice(0, 40) + "..." : displayCmd,
        pid: child.pid,
        // Through the store, so a process stopped by Esc is recorded as
        // killed (not failed) exactly as one stopped by /kill.
        kill: () => {
          if (store.getState().killProcess(procId)) return;
          try {
            if (process.platform === "win32" && child.pid) {
              spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
            } else {
              killUnixTree(child.pid);
            }
          } catch {}
        },
      });

      // Auto-kill after timeout
      const bgTimer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch {}
        store.getState().appendProcessOutput(procId, `[killed: exceeded ${BG_TIMEOUT / 1000}s timeout]`);
      }, BG_TIMEOUT);


      let bgOutputSize = 0;
      const onData = (data) => {
        bgOutputSize += data.length;
        if (bgOutputSize > BG_MAX_OUTPUT) {
          try { child.kill("SIGKILL"); } catch {}
          store.getState().appendProcessOutput(procId, `[killed: output exceeded ${BG_MAX_OUTPUT / 1024 / 1024} MB]`);
          return;
        }
        const lines = data.toString().split("\n");
        for (const line of lines) {
          if (line) {
            // Kept for /logs and the dock; never printed into the chat.
            store.getState().appendProcessOutput(procId, line);
          }
        }
      };

      child.stdout.on("data", onData);
      child.stderr.on("data", onData);

      child.on("close", (code) => {
        clearTimeout(bgTimer);
        activeChildren.delete(procId);
        store.getState().unregisterTask(taskRegId);
        store.getState().finishProcess(procId, code);
        const proc = store.getState().processes.find((p) => p.id === procId);
        const elapsed = fmtElapsed(Date.now() - (proc?.startTime || Date.now()));
        printProcessEnd(procId, command, code, elapsed, proc?.status);

        const allProcs = store.getState().processes.filter((p) => batchFrom == null || p.id >= batchFrom);
        const running = allProcs.filter((p) => p.status === "running");
        if (running.length === 0) {
          if (allProcs.length > 1) {
            const done = allProcs.filter((p) => p.status === "done").length;
            const failed = allProcs.filter((p) => p.status === "failed").length;
            const killed = allProcs.filter((p) => p.status === "killed").length;
            printProcessSummary(allProcs.length, done, failed, killed);
          }
        }
      });

      child.on("error", (err) => {
        store.getState().appendProcessOutput(procId, `Error: ${err.message}`);
        store.getState().finishProcess(procId, 1, "failed");
      });

      return `Background process started (id: ${procId}, pid: ${child.pid}). Command: ${command}\nOutput: /logs ${procId}. Stop: /kill ${procId}.`;
    },
  };
}
