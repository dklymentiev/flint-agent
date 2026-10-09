// Model check: six small agent tasks with answers a program can verify, run
// on a model, scored and saved (docs/model-check.md). OpenRouter tells how
// fast a model is, not whether it can do an agent's work; the free list
// ranked light models by their names until this measured it.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { trackTempDir } from "./temp-tracker.js";
import { homeStateDir } from "./data-dir.js";
import { getKey } from "./providers/keys.js";

const read = (dir, f) => { try { return readFileSync(path.join(dir, f), "utf8"); } catch { return null; } };

const NUMBERS = [17, 25, 8, 13];
export const SUM_EXPECTED = NUMBERS.reduce((a, b) => a + b, 0);

export const CHECK_TASKS = [
  {
    id: "write-file",
    prompt: "Create a file named hello.txt in the current folder containing exactly: flint-check",
    check: ({ dir }) => (read(dir, "hello.txt") || "").trim() === "flint-check",
  },
  {
    id: "read-sum",
    prompt: "The file data.txt in the current folder holds numbers, one per line. Read it and reply with their sum, digits only.",
    setup: (dir) => writeFileSync(path.join(dir, "data.txt"), NUMBERS.join("\n") + "\n"),
    check: ({ answer }) => new RegExp(`\\b${SUM_EXPECTED}\\b`).test(String(answer || "")),
  },
  {
    id: "edit-json",
    prompt: "In config.json in the current folder, change the port to 8080. Keep the file valid JSON and keep the other fields.",
    setup: (dir) => writeFileSync(path.join(dir, "config.json"), JSON.stringify({ port: 3000, name: "demo" }, null, 2) + "\n"),
    check: ({ dir }) => {
      try { const j = JSON.parse(read(dir, "config.json")); return j.port === 8080 && j.name === "demo"; } catch { return false; }
    },
  },
  {
    id: "run-command",
    prompt: 'Run this command: node -e "console.log(6*7)" and reply with its output only.',
    check: ({ answer, tools = [] }) =>
      tools.some((t) => /run_command|run_background|exec|shell|bash/.test(t.name)) && /\b42\b/.test(String(answer || "")),
  },
  {
    id: "multi-step",
    prompt: "Create a folder named out in the current folder with two files: a.txt containing A and b.txt containing B. Then list the folder and reply with the file names, comma-separated.",
    check: ({ dir, answer }) =>
      (read(path.join(dir, "out"), "a.txt") || "").trim() === "A"
      && (read(path.join(dir, "out"), "b.txt") || "").trim() === "B"
      && /a\.txt/.test(answer || "") && /b\.txt/.test(answer || ""),
  },
  {
    id: "restraint",
    prompt: "Reply with the word ready and do nothing else.",
    check: ({ answer, tools = [] }) => tools.length === 0 && String(answer || "").trim().replace(/[.!*"'`]/g, "").toLowerCase() === "ready",
  },
];

export const scoreOf = (tasks) => tasks.filter((t) => t.passed).length;

// ── Saved results ───────────────────────────────────────────

function checksFile() {
  return path.join(homeStateDir(), "model-checks.json");
}
export function loadChecks() {
  try { return existsSync(checksFile()) ? JSON.parse(readFileSync(checksFile(), "utf8")) : {}; } catch { return {}; }
}
export function saveCheck(result) {
  const all = loadChecks();
  all[result.model] = result;
  mkdirSync(path.dirname(checksFile()), { recursive: true });
  writeFileSync(checksFile(), JSON.stringify(all, null, 2) + "\n");
}

const FRESH_DAYS = 14;
/** The list with each model's saved score; only a fresh one ranks. */
export function withScores(list, now = new Date()) {
  const checks = loadChecks();
  return (list || []).map((m) => {
    const c = checks[m.id];
    if (!c) return m;
    const fresh = now - new Date(c.checkedAt) <= FRESH_DAYS * 86400e3;
    return { ...m, checkScore: c.score, scoreFresh: fresh, score: fresh ? c.score : undefined };
  });
}

// ── Running ─────────────────────────────────────────────────

/** The longest one task may take. FLINT_CHECK_TASK_TIMEOUT_S overrides the 120 s default. */
export const DEFAULT_TASK_TIMEOUT_MS = 120000;
export function taskTimeoutMs() {
  const s = parseFloat(process.env.FLINT_CHECK_TASK_TIMEOUT_S || "");
  return s > 0 ? s * 1000 : DEFAULT_TASK_TIMEOUT_MS;
}

// A race whose timer is always cleared: the plain Promise.race version left a
// pending timer behind for every task, up to timeoutMs + 15 s each.
const withTimeout = (p, ms) => {
  let timer;
  const limit = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`timed out after ${Math.round(ms / 1000)} s`)), ms); });
  return Promise.race([p, limit]).finally(() => clearTimeout(timer));
};

/**
 * The reason to give up on a model, from the structured error the agent
 * reported for the task just run; null for anything else. Only a definite
 * verdict counts: 404 model-not-found and 401/403 auth. A 5xx, a timeout or
 * a rate limit is an ordinary task failure and the check goes on.
 */
export function definiteVerdict(pe) {
  if (!pe) return null;
  if (pe.kind === "model-not-found") return `${pe.status || 404}: the provider does not serve this model`;
  if (pe.kind === "auth") return `${pe.status || 401}: the provider refused the key (no access to this model)`;
  return null;
}

/**
 * Run the six tasks on one model; saves and returns { model, score, checkedAt, tasks }.
 *
 * Each task gets its own agent, so the conversation of task 1 is not in the
 * context of task 6 (one long-lived agent reached 96K input tokens over the
 * six). The cost of that is six cold starts; the next agent is started while
 * the current task runs, so the wait mostly overlaps with the model's work.
 * The agent's readiness is awaited before the clock for a task starts.
 */
export async function runCheck(model, { startAgent = agentFactory || startStdioAgent, timeoutMs = taskTimeoutMs() } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "flint-check-"));
  trackTempDir(dir);
  // A start that fails is a rejected promise nobody may have awaited yet.
  const launch = () => {
    const p = Promise.resolve().then(() => startAgent({ model, cwd: dir }));
    p.catch(() => {});
    return p;
  };
  const tasks = [];
  let unavailable = null;
  let incomplete = false;
  let next = launch();
  try {
    for (let i = 0; i < CHECK_TASKS.length; i++) {
      const t = CHECK_TASKS[i];
      const starting = next;
      next = null;
      t.setup?.(dir);
      let agent = null;
      let r = null;
      let error;
      let t0 = Date.now();
      try {
        agent = await starting;
        await agent.ready?.();
        t0 = Date.now();
        if (i + 1 < CHECK_TASKS.length) next = launch();
        r = await withTimeout(agent.ask(t.prompt, { timeoutMs }), timeoutMs + 15000);
      } catch (err) {
        error = agent ? err.message : `agent did not start: ${err.message}`;
        // An agent that never came up says nothing about the model.
        if (!agent || /did not start|^agent (exited|could not start)/.test(err.message)) incomplete = true;
        if (!next && i + 1 < CHECK_TASKS.length) next = launch();
      } finally {
        if (agent) { try { await agent.close(); } catch {} }
      }
      const tools = r?.tools || [];
      const verdict = definiteVerdict(r?.providerError);
      tasks.push({
        id: t.id,
        passed: r ? !!t.check({ dir, answer: r.answer || "", tools }) : false,
        seconds: Math.round((Date.now() - t0) / 100) / 10,
        toolCalls: tools.length,
        toolErrors: tools.filter((x) => x.isError).length,
        tokensIn: r?.usage?.input_tokens || 0,
        tokensOut: r?.usage?.output_tokens || 0,
        ...(error ? { error } : {}),
        ...(verdict ? { error: verdict } : {}),
      });
      if (verdict) { unavailable = verdict; break; }
    }
  } finally {
    // An agent started ahead for a task that will not run.
    if (next) { try { (await next).close(); } catch {} }
  }
  // The provider said this model cannot be used (no such model, no access):
  // that is a fact about the account, not a score. Nothing is saved.
  if (unavailable) return { model, score: null, unavailable, checkedAt: new Date().toISOString(), tasks };
  const result = { model, score: scoreOf(tasks), checkedAt: new Date().toISOString(), tasks, ...(incomplete ? { incomplete: true } : {}) };
  // Do not record a score when every task failed: that is an infrastructure
  // failure (missing key, wrong URL, subprocess crash), not a model weakness.
  // Saving a 0/6 would pollute the rankings with a healthy model marked broken.
  // The same goes for a run in which an agent did not come up: its tasks were
  // never asked, so the score would measure our start, not the model.
  if (result.score > 0 && !incomplete) saveCheck(result);
  return result;
}

let agentFactory = null;
/** For tests: replace how an agent is started. */
export function setCheckAgentFactory(fn) { agentFactory = fn; }

const FLINT_BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "flint.js");

/**
 * A Flint in stdio mode for one model, in `cwd`, with its own data folder,
 * no MCP servers and every tool allowed. ask() sends one turn and returns
 * the answer, the tool calls (with whether they failed) and the usage.
 */
/**
 * Build the environment for the model-check subprocess.
 *
 * The subprocess gets its own FLINT_DATA_DIR (a temp dir), so the operator's
 * encrypted key in the real data dir is invisible to it. This function reads
 * the key from the real data dir and adds it to the env var the subprocess's
 * config.resolveApiKey() checks first (in headless mode, env wins). The key
 * value is never printed or logged — it lives only in the env object passed
 * to spawn().
 *
 * @param {string} dataDir - the temp FLINT_DATA_DIR for the subprocess
 * @param {string|null} apiKey - the operator's key from the real data dir, or null
 * @returns {Record<string, string>} the child process environment
 */
export function buildCheckEnv(dataDir, apiKey) {
  const childEnv = { ...process.env, FLINT_DATA_DIR: dataDir, MCP_SERVERS: "", FLINT_UPDATE_CHECK: "0", FLINT_SWAP_FROM: "100000000" };
  if (apiKey) childEnv.OPENROUTER_API_KEY = apiKey;
  return childEnv;
}

// How long a cold start may take before the agent counts as not started.
// Generous: a first start loads the whole tool registry and, on a slow disk
// or under load, takes tens of seconds. FLINT_CHECK_STARTUP_S overrides it.
export const DEFAULT_STARTUP_MS = 120000;
export const startupLimitMs = () => {
  const s = parseFloat(process.env.FLINT_CHECK_STARTUP_S || "");
  return s > 0 ? s * 1000 : DEFAULT_STARTUP_MS;
};

export async function startStdioAgent({ model, cwd, startupMs = startupLimitMs(), bin = FLINT_BIN, env = {}, args = [] }) {
  const data = mkdtempSync(path.join(tmpdir(), "flint-check-data-"));
  trackTempDir(data);
  // Read the operator's key from the real data dir (before FLINT_DATA_DIR is
  // overridden to a temp dir) and pass it through the env var so the
  // subprocess can authenticate. Never print or log the key value.
  const apiKey = await getKey("openrouter");
  const childEnv = { ...buildCheckEnv(data, apiKey), ...env };
  const child = spawn(process.execPath, [bin, "--print", "--input-format", "stream-json", "--output-format", "stream-json",
    "--model", model, "--session-id", randomUUID(), "--dangerously-skip-permissions", ...args], {
    cwd, stdio: ["pipe", "pipe", "pipe"],
    env: childEnv,
  });
  // stderr is the agent's diagnostics, not a protocol: nothing is decided
  // from it (a tool output or a retried proxy line would be taken for a
  // verdict on the model), so it is only drained.
  child.stderr.on("data", () => {});
  child.stdin.on("error", () => {});   // a dead child must not become an uncaught EPIPE

  // Ready = the init event the stdio mode prints once the agent can take a
  // turn (src/stdio/run.js). A first turn sent before it ran into a cold
  // start. The wait is a promise with one timer that is cleared however it
  // ends; nothing here throws inside an event handler.
  let exited = null;
  let settleReady;
  const readyP = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`agent did not start within ${Math.round(startupMs / 1000)} s`)), startupMs);
    settleReady = (err) => { clearTimeout(timer); err ? reject(err) : resolve(); };
  });
  readyP.catch(() => {});   // a caller that never asks must not leave an unhandled rejection

  let buf = "";
  let waiting = null;   // { tools, resolve, reject }
  const ids = new Map();
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      let ev; try { ev = JSON.parse(line); } catch { continue; }
      if (ev.type === "system" && ev.subtype === "init") { settleReady(); continue; }
      if (!waiting) continue;
      if (ev.type === "assistant") {
        for (const b of ev.message?.content || []) if (b.type === "tool_use") { const t = { name: b.name, isError: false }; ids.set(b.id, t); waiting.tools.push(t); }
      } else if (ev.type === "user") {
        for (const b of ev.message?.content || []) if (b.type === "tool_result" && b.is_error && ids.get(b.tool_use_id)) ids.get(b.tool_use_id).isError = true;
      } else if (ev.type === "result") {
        const w = waiting; waiting = null;
        w.resolve({ answer: ev.result || "", tools: w.tools, usage: ev.usage || {}, subtype: ev.subtype, ...(ev.provider_error ? { providerError: ev.provider_error } : {}) });
      }
    }
  });
  const onGone = (why) => {
    exited = exited || why;
    settleReady(new Error(`agent ${exited} before it was ready`));
    const w = waiting; waiting = null;
    w?.reject(new Error(`agent ${exited}`));
  };
  child.on("exit", (code) => onGone(`exited (code ${code})`));
  child.on("error", (err) => onGone(`could not start: ${err.message}`));

  const send = (o) => { try { child.stdin.write(JSON.stringify(o) + "\n"); } catch {} };
  return {
    ready: () => readyP,
    async ask(prompt, { timeoutMs = 120000 } = {}) {
      await readyP;
      if (exited) throw new Error(`agent ${exited}`);
      return new Promise((resolve, reject) => {
        let timer = setTimeout(() => {
          // Stop the turn, wait for its end, and fail the task.
          send({ type: "control_request", request_id: `stop-${Date.now()}`, request: { subtype: "interrupt" } });
          const w = waiting;
          const giveUp = () => { clearTimeout(grace); if (waiting === w) waiting = null; reject(new Error(`timed out after ${Math.round(timeoutMs / 1000)} s`)); };
          const grace = setTimeout(giveUp, 10000);
          if (w) { w.resolve = giveUp; w.reject = giveUp; } else giveUp();
        }, timeoutMs);
        const done = (fn) => (v) => { clearTimeout(timer); fn(v); };
        waiting = { tools: [], resolve: done(resolve), reject: done(reject) };
        send({ type: "user", message: { role: "user", content: prompt } });
      });
    },
    async close() {
      settleReady(new Error("agent closed"));
      if (exited) return;
      try { child.stdin.end(); } catch {}
      await new Promise((r) => { const t = setTimeout(() => { child.kill(); r(); }, 8000); child.on("exit", () => { clearTimeout(t); r(); }); });
    },
  };
}

// ── The command's background run ────────────────────────────

let lastRun = Promise.resolve();
export function lastCheckRun() { return lastRun; }

/** Check `models` one by one in the background; `log` gets a line per model and a table. */
export function startCheckRun(models, log) {
  lastRun = (async () => {
    const results = [];
    for (const model of models) {
      log(`checking ${model} (6 tasks)...`);
      try {
        const r = await runCheck(model);
        if (r.unavailable) { log(`${model}  unavailable: ${r.unavailable}`); continue; }
        results.push(r);
        const secs = r.tasks.reduce((s, t) => s + t.seconds, 0);
        const failed = r.tasks.filter((t) => !t.passed).map((t) => t.id).join(", ");
        log(`${model}  ${r.score}/6  ${secs.toFixed(0)} s${failed ? `  failed: ${failed}` : ""}`);
      } catch (err) {
        log(`${model}  could not run: ${err.message}`);
      }
    }
    if (results.length > 1) {
      log("results, best first:");
      for (const r of [...results].sort((a, b) => b.score - a.score)) log(`  ${String(r.score).padStart(1)}/6  ${r.model}`);
    }
  })();
  return lastRun;
}
