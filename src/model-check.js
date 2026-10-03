// Model check: six small agent tasks with answers a program can verify, run
// on a model, scored and saved (docs/model-check.md). OpenRouter tells how
// fast a model is, not whether it can do an agent's work; the free list
// ranked light models by their names until this measured it.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
  const dir = process.env.FLINT_DATA_DIR ? path.resolve(process.env.FLINT_DATA_DIR) : path.join(homedir(), ".flint");
  return path.join(dir, "model-checks.json");
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

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`timed out after ${Math.round(ms / 1000)} s`)), ms))]);

/** Run the six tasks on one model; saves and returns { model, score, checkedAt, tasks }. */
export async function runCheck(model, { startAgent = agentFactory || startStdioAgent, timeoutMs = 120000 } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "flint-check-"));
  const agent = await startAgent({ model, cwd: dir });
  const tasks = [];
  try {
    for (const t of CHECK_TASKS) {
      t.setup?.(dir);
      const t0 = Date.now();
      let r = null;
      let error;
      try {
        r = await withTimeout(agent.ask(t.prompt, { timeoutMs }), timeoutMs + 15000);
      } catch (err) {
        error = err.message;
      }
      const tools = r?.tools || [];
      tasks.push({
        id: t.id,
        passed: r ? !!t.check({ dir, answer: r.answer || "", tools }) : false,
        seconds: Math.round((Date.now() - t0) / 100) / 10,
        toolCalls: tools.length,
        toolErrors: tools.filter((x) => x.isError).length,
        tokensIn: r?.usage?.input_tokens || 0,
        tokensOut: r?.usage?.output_tokens || 0,
        ...(error ? { error } : {}),
      });
    }
  } finally {
    try { await agent.close(); } catch {}
  }
  const result = { model, score: scoreOf(tasks), checkedAt: new Date().toISOString(), tasks };
  saveCheck(result);
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
export async function startStdioAgent({ model, cwd }) {
  const data = mkdtempSync(path.join(tmpdir(), "flint-check-data-"));
  const child = spawn(process.execPath, [FLINT_BIN, "--print", "--input-format", "stream-json", "--output-format", "stream-json",
    "--model", model, "--session-id", randomUUID(), "--dangerously-skip-permissions"], {
    cwd, stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, FLINT_DATA_DIR: data, MCP_SERVERS: "", FLINT_UPDATE_CHECK: "0", FLINT_SWAP_FROM: "100000000" },
  });
  child.stderr.on("data", () => {});
  let buf = "";
  let waiting = null;   // { tools, resolve }
  const ids = new Map();
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      let ev; try { ev = JSON.parse(line); } catch { continue; }
      if (!waiting) continue;
      if (ev.type === "assistant") {
        for (const b of ev.message?.content || []) if (b.type === "tool_use") { const t = { name: b.name, isError: false }; ids.set(b.id, t); waiting.tools.push(t); }
      } else if (ev.type === "user") {
        for (const b of ev.message?.content || []) if (b.type === "tool_result" && b.is_error && ids.get(b.tool_use_id)) ids.get(b.tool_use_id).isError = true;
      } else if (ev.type === "result") {
        const w = waiting; waiting = null;
        w.resolve({ answer: ev.result || "", tools: w.tools, usage: ev.usage || {}, subtype: ev.subtype });
      }
    }
  });
  const send = (o) => child.stdin.write(JSON.stringify(o) + "\n");
  return {
    ask(prompt, { timeoutMs = 120000 } = {}) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          // Stop the turn, wait for its end, and fail the task.
          send({ type: "control_request", request_id: `stop-${Date.now()}`, request: { subtype: "interrupt" } });
          const w = waiting;
          setTimeout(() => { if (waiting === w) waiting = null; }, 10000);
          if (w) w.resolve = () => reject(new Error(`timed out after ${Math.round(timeoutMs / 1000)} s`));
          else reject(new Error("timed out"));
        }, timeoutMs);
        waiting = { tools: [], resolve: (r) => { clearTimeout(timer); resolve(r); } };
        send({ type: "user", message: { role: "user", content: prompt } });
      });
    },
    async close() {
      child.stdin.end();
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
