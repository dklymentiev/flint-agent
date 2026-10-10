// Before everything: --data-dir becomes FLINT_DATA_DIR, so no module computes
// a path from the old value (data-dir-flag.js).
import "./data-dir-flag.js";
// Then: in the stdio mode it moves every stray write off stdout before any
// other module can print (stdio/guard.js).
import { stdioArgs, protocolWrite } from "./stdio/guard.js";
// --help answers before any module that does work at load time (early-flags.js).
import "./early-flags.js";
// `node src/index.js --version`: the version, and nothing started.
if (process.argv.includes("--version") || process.argv.includes("-v")) {
  const { readFileSync: readPkg } = await import("node:fs");
  console.log(`flint ${JSON.parse(readPkg(new URL("../package.json", import.meta.url), "utf8")).version}`);
  process.exit(0);
}
// Then: React and Ink load their production builds (production-env.js).
import { restoreNodeEnv } from "./production-env.js";
import { execSync, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { format } from "node:util";
import chalk from "chalk";
import { apiUrl } from "./api/address.js";

// Fix Cyrillic/Unicode display in Windows console
if (process.platform === "win32") {
  try { execSync("chcp 65001", { stdio: "ignore" }); } catch {}
}

// Ink + readline + our handlers add multiple SIGINT listeners -- raise limit
process.setMaxListeners(20);

// Emergency kill: Ctrl+C (x3 in 2s) = force exit
let _sigintCount = 0;
let _sigintReset = null;
process.on("SIGINT", () => {
  _sigintCount++;
  if (_sigintCount >= 3) {
    process.stderr.write("\n[FORCE EXIT] Triple Ctrl+C\n");
    process.exit(1);
  }
  if (_sigintReset) clearTimeout(_sigintReset);
  _sigintReset = setTimeout(() => { _sigintCount = 0; }, 2000);
  _sigintReset?.unref?.();
});

// Startup watchdog: if app doesn't finish init within 30s, exit. Paused while
// a first-run question waits for the operator (see startup-watchdog.js).
import { fakeStdinTTY, stdinIsRealTTY, noTerminalSetupRefusal, watchForEmptyInput, NO_INPUT_MESSAGE } from "./tty.js";
import { startStartupWatchdog, clearStartupWatchdog, whileWaitingForOperator } from "./startup-watchdog.js";
startStartupWatchdog();

// Patch stdin only when truly needed (non-TTY fallback for piped/CI). Not in
// the stdio mode: there stdin is the protocol, and a stdin that claims to be
// a terminal would make the first-run questions wait on it.
// The stand-in is marked (tty.js): the first-run questions must not trust it.
if (!process.stdin.isTTY && !stdioArgs) fakeStdinTTY();

import React from "react";
import { render } from "ink";
import { config, needsFirstRunSetup } from "./config.js";
import { trackTempFile } from "./temp-tracker.js";
import { store } from "./store/index.js";
import { app, sessionData } from "./app-state.js";
import { parseCLI, runListSessions, migrateKeys, runFirstRunSetup } from "./cli.js";
import { bootstrap } from "./bootstrap.js";
import { processMessage, handlePendingAction } from "./message-handler.js";
import { withLock } from "./input-handler.js"; // serializes /commands, /paste, /auto
import * as bus from "./bus/index.js";
import { notify as busPush, flush as busFlush, waitForResult, isProcessing } from "./bus/drain-loop.js";
import { loadPlugins, stopPlugins } from "./bus/plugins.js";
import { printHeader, userMsgLine, addIndented, INDENT, ANSI_RE } from "./ui/header.js";
import { initCommands, tryHandleCommand, isSlashCommand } from "./commands/registry.js";
import { setSupervisorEnabled } from "./agent/supervisor.js";
import { runAutoMode } from "./agent/auto.js";
import { initPermissions, bulkSetPermission } from "./tools/permissions.js";
import { startHeadless, prepareHeadless, headlessSetupRefusal } from "./headless-start.js";
import { buildHeadlessResult, modifiedFilesIn, runTotals, createHeadlessRun, gitChangesIn, installHeadlessSignals } from "./headless-run.js";
import { homeStateDir, stateDirRefusal } from "./data-dir.js";
import { carriedBulkPermission } from "./restart.js";
import { initSecurity } from "./security/index.js";
import { fetchModelInfo } from "./api/client.js";
import { startServer } from "./api/server.js";
import { logChatLine } from "./logging/chat-log.js";
import { createChatLogFollower } from "./logging/chat-log-follower.js";
import { setInkActive, createLogger } from "./logging/logger.js";
import { startLogCollector } from "./logging/log-collector.js";
import { killAllChildren } from "./tools/system.js";
import { killAllChildrenSync } from "./tools/process-tools.js";
import { pushInbox } from "./memory/inbox.js";
import { getActiveGoal, getTaskStats, syncPlanToStore, abandonGoal, getDueReminders, fireReminder, claimTask, getTask as getTaskById, completeTaskWithResult, gcStaleSessions } from "./tasks/queries.js";
import { closeDb } from "./tasks/db.js";
import { registerAgent, unregisterAgent } from "./registry.js";
import {
  generateSessionId,
  saveSession,
  loadSession,
  listSessions,
} from "./sessions.js";
import { RENDER_OPTIONS } from "./ui/render-options.js";
import { stripTimeStamp } from "./agent/time-stamp.js";
import { App } from "./components/App.js";
import { initOutput, printSystem, printWarning, printConfirmResult } from "./ui/output.js";

const { createElement: h } = React;

// Every module has loaded and React has picked its build; commands the agent
// runs get the NODE_ENV the operator started Flint with.
restoreNodeEnv();
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8"));

// -- CLI --

const cli = stdioArgs ? { action: "stdio", ...stdioArgs } : parseCLI();

// Nobody is at the keyboard in a headless run, and the run belongs in --cwd.
// Both have to be settled here, before anything below can ask a question or
// read the working directory: the flag used to be set in the headless block
// near the end of this file, after bootstrap() had already drawn the first-run
// menu and frozen the install directory into the system message.
// bootstrap() repeats this call as its own first step; see prepareHeadless.
prepareHeadless(cli);

if (cli.action === "list") {
  await runListSessions();
}

// Nowhere to write is settled here, once, before the first module that writes.
{
  const refusal = stateDirRefusal([homeStateDir(), config.sessionsDir]);
  if (refusal) {
    process.stderr.write(refusal + "\n");
    process.exit(78); // EX_CONFIG, the same code a failed security init uses
  }
}

// -- Auto-migrate env keys + first-run wizard --

// A host gives stdio credentials for this process only. Importing them into
// ~/.flint/keys.enc would make a per-turn secret persist under the agent user.
if (cli.action !== "stdio") await migrateKeys();
{
  // The key wizard reads stdin. A headless run has nobody to type into it.
  const refusal = headlessSetupRefusal(cli, needsFirstRunSetup);
  if (refusal) {
    process.stderr.write(refusal + "\n");
    process.exit(1);
  }
}
{
  // The wizard reads stdin. With no terminal it would wait for ever (the
  // startup watchdog is lifted while it waits), so say what is missing instead.
  const refusal = noTerminalSetupRefusal(cli, needsFirstRunSetup, stdinIsRealTTY());
  if (refusal) {
    process.stderr.write(refusal + "\n");
    process.exit(1);
  }
}
if (needsFirstRunSetup && cli.action !== "list" && cli.action !== "stdio" && cli.action !== "check") {
  await whileWaitingForOperator(() => runFirstRunSetup(cli));
}

// Resolve API key from encrypted storage
await config.resolveApiKey({ preferEnv: cli.action === "stdio" });

// -- Headless mode: set unattended flag BEFORE bootstrap so permissions
// use the 0-timeout path instead of the 600 s timer.
let headlessRun = null;
if (cli.action === "headless") {
  startHeadless({ cwd: cli.cwd });

  // The run and its signal handlers exist BEFORE bootstrap and before the
  // task block near the end of this file. The general gracefulShutdown() and
  // its handlers are defined after that block and never reached by a headless
  // run. A signal stops the run (headless-run.js): the turn in flight is
  // aborted, or no turn starts if none has yet; the session is saved, the
  // record is written with stop_reason "killed", and the process exits 2.
  headlessRun = createHeadlessRun({
    app,
    processMessage,
    saveSession: () => saveSession(store.getState().sessionId, sessionData(store)),
    buildResult: (stopReason, result) => headlessResult(stopReason, result),
    gitChanges: () => gitChangesIn(config.workdir),
    write: (text, flushed) => process.stdout.write(text, flushed),
    exit: (code) => process.exit(code),
    logError: (line) => process.stderr.write(line),
    killChildren: killAllChildrenSync,
  });
  installHeadlessSignals(process, headlessRun);
  process.on("exit", () => {
    if (!app.shuttingDown) killAllChildrenSync();
  });
}

// Free mode survives a restart when its primary is still the model
// (docs/free-mode.md); its notices go to the console.
{
  const { loadFreeChain } = await import("./free-models.js");
  const { setFreeNoticeSink } = await import("./api/client.js");
  const chain = loadFreeChain();
  if (chain && chain[0] === config.model) config.freeChain = chain;
  setFreeNoticeSink((line) => store.getState().addLine(chalk.yellow(`  ${line}`)));
}

// Set provider in store
store.setState({ provider: config.provider });

// One folder for every file tool, in every mode: the folder Flint was started
// from. Relative reads, writes, searches and shell commands all use it, as an
// agent CLI would. Writes used to go to a per-session workspace while reads and
// searches looked in Flint's own install folder, so the agent could not read
// what it had just written (a test agent could not find junk.txt beside its own
// CLAUDE.md, 2026-10-02; a tester's data.csv, 2026-10-08). The launcher passes
// the real start folder because it runs this process from the install folder.
{
  // A headless --cwd already chose its folder in prepareHeadless() above: keep it.
  const launchDir = process.env.FLINT_LAUNCH_DIR || process.cwd();
  if (!config.workdirBase) config.workdirBase = config.baseDir || launchDir;
  if (!config.baseDir) config.baseDir = launchDir;
}

// -- stdio mode: the host's instructions and MCP servers, before bootstrap
// builds the system prompt and connects the servers --
// Headless mode's host identity (instructions + .mcp.json from --cwd) is
// handled in bootstrap(), so it works for direct callers too.
if (cli.action === "stdio") {
  const { hostPromptFrom, mcpConfigPath } = await import("./stdio/session.js");
  const { mcpJsonServers, parseServerConfig } = await import("./mcp-client.js");
  try {
    app.hostPrompt = hostPromptFrom(cli);
    const mcpFile = mcpConfigPath(cli);
    if (mcpFile) {
      const fromFile = mcpJsonServers(JSON.parse(readFileSync(mcpFile, "utf-8")));
      config.mcpServers = [...parseServerConfig(config.mcpServers), ...fromFile];
    }
  } catch (err) {
    process.stderr.write(`[flint] ${err.message}\n`);
    process.exit(2);
  }
}

// -- Console and headless: the operator's own MCP file, which is where a
// server that needs a header is configured (mcp-client.js) --
let mcpConfigProblem = null;
if (cli.action !== "stdio") {
  try {
    const { withUserMcpServers } = await import("./mcp-client.js");
    const merged = withUserMcpServers(config.mcpServers);
    if (merged) config.mcpServers = merged;
  } catch (err) {
    // Said once the console is up; the servers of MCP_SERVERS still connect.
    mcpConfigProblem = err.message;
  }
}

// -- Bootstrap all subsystems --

const { log } = await bootstrap(cli, pkg);

// -- Subscribe to lines[] for full chat log --
//
// This tracked its position with `lines.length`, which stops moving once
// addLine's 1000-line cap drops the oldest entries: the condition
// `lines.length > lastLineCount` is then false forever and chat.log stops
// mid-session with no error (#9). The follower tracks the store's monotonic
// line id instead, which keeps advancing, and reports a gap if it started
// after lines were already on screen.
const chatLogFollower = createChatLogFollower({
  getState: () => store.getState(),
  subscribe: (fn) => store.subscribe(fn),
  log: (sessionId, text) => logChatLine(sessionId, text),
});
const { skipped } = chatLogFollower.start();
if (skipped > 0) {
  logChatLine(store.getState().sessionId ?? "",
    `[chat-log] ${skipped} line(s) were on screen before the log follower started and are not in this file.`);
}

// -- Override console.log to go to store --

console.log = (...args) => store.getState().addLine(format(...args));
console.error = (...args) => store.getState().addLine(chalk.red(format(...args)));

// -- stdio mode: no UI, no server, no bus. Runs until stdin closes. --
if (cli.action === "stdio") {
  clearStartupWatchdog();
  const { runStdio } = await import("./stdio/run.js");
  await runStdio({ opts: cli, write: protocolWrite, version: pkg.version });
}

// -- Headless mode: skip UI, run task, exit --
// The structured JSON result a headless caller reads to learn what happened in
// the run (headless-run.js builds it). `stopReason` is "done", "time" or
// "killed". Every number is this run's: the session totals now, minus what
// they were when the task started. The folder is config.workdir, the one the
// file tools and auto-verify use.
function headlessResult(stopReason, fromResult) {
  return buildHeadlessResult({
    stopReason,
    result: fromResult,
    state: store.getState(),
    baseline: headlessBaseline,
    durationMs: Date.now() - headlessStartTime,
    model: config.model,
    modifiedFiles: modifiedFilesIn(config.workdir),
  });
}

if (cli.action === "headless") {
  clearStartupWatchdog();
  if (!cli.task) {
    process.stderr.write("[headless] --task is required\n");
    process.exit(1);
  }
  // Apply budget override for headless mode
  if (cli.budget) { config.maxCostPerAction = cli.budget; }
  // Wall-clock start of the headless run, captured before any work so the
  // result's duration_ms reflects the true elapsed time regardless of how the
  // run ends (normal, time limit, or external kill). var (not const) because
  // headlessResult, defined above the if-block, closes over it.
  var headlessStartTime = Date.now();
  // What the session had already spent and called before this task: nothing
  // for a new session, the earlier runs for a resumed one (--session).
  var headlessBaseline = runTotals(store.getState());
  // Wall-clock time limit for headless runs (seconds). When set, a timer
  // aborts the agent loop if it runs past this many seconds, so a hung model
  // call or runaway tool call cannot run forever in CI or a bench subject.
  if (cli.timeLimit) { config.timeLimit = cli.timeLimit; }
  // Redirect store output to stderr (stdout reserved for structured result)
  const _origAddLine = store.getState().addLine.bind(store.getState());
  store.getState().addLine = (text) => {
    const raw = typeof text === "string" ? text.replace(/\x1b\[[0-9;]*m/g, "") : String(text);
    if (raw.trim()) process.stderr.write(raw.trim() + "\n");
    return _origAddLine(text);
  };
  // The task, the auto-verify retry and the time limit: headless-run.js. It
  // ends the process itself, on every path.
  await headlessRun.run({ task: cli.task, timeLimitSec: config.timeLimit });
  // The exit happens when stdout has taken the record. Nothing below this
  // block is for a headless run (it starts the console), so wait here.
  await new Promise(() => {});
}

// -- Check mode: minimal runtime probe (--check) --
//
// Verifies three things in seconds and a fraction of a cent, without the setup
// a full --headless run needs: (1) an API key is present, (2) the model
// answers, (3) a tool call round-trips. The probe itself is check-probe.js.
if (cli.action === "check") {
  clearStartupWatchdog();
  const { CHECK_TASKS } = await import("./model-check.js");
  const { runCheckProbe } = await import("./check-probe.js");
  const { chatCompletion } = await import("./api/client.js");
  const { processToolDefs } = await import("./tools/process-tools.js");
  const { executeToolWithPermissions } = await import("./tools/permissions.js");

  // The command the model asks for runs the way a headless run's commands do:
  // tools allowed, nobody to answer a prompt, so whatever a guard wants
  // confirmed is refused (permissions.js).
  startHeadless();

  const outcome = await runCheckProbe({
    task: CHECK_TASKS.find((t) => t.id === "run-command"),
    hasKey: !!config.apiKey,
    chat: (messages) => chatCompletion(messages, processToolDefs, null, { timeoutMs: 15000, stream: false }),
    runTool: async (name, args) => {
      const r = await executeToolWithPermissions(name, args, { sessionId: store.getState().sessionId || "" });
      return { content: typeof r.result === "string" ? r.result : JSON.stringify(r.result), denied: !!r.denied };
    },
    dir: process.cwd(),
    provider: config.provider,
    model: config.model,
  });
  // A command tool can leave a process behind (run_background_command).
  killAllChildrenSync();
  if (outcome.stderr) process.stderr.write(outcome.stderr);
  if (outcome.stdout) process.stdout.write(outcome.stdout);
  process.exit(outcome.code);
}

// -- Start ink UI --

function handleAbort() {
  const s = store.getState();
  // Esc ends the agent task. It does not discard the queue.
  //
  // This used to call busFlush() on an agent-loop hit, which failed every
  // pending message as "flushed" while also killing the running task. In
  // session 2026-09-30T00-37-42 those are the two log lines 19 ms apart: the
  // question typed at 19:59:52 discarded unread, and the task killed with it.
  // The only way to ask a question mid-work cost the operator both.
  //
  // The API's /stop still aborts the whole loop, and flush() is still what
  // /new and an explicit API abort use -- discarding the queue is the request
  // there. Esc is not one of those.
  //
  // What changed on 2026-09-30 (item 6 follow-up): Esc stopped meaning "end
  // the step" for the operator who never asked for that distinction. Pressed
  // ten times against one running task, it printed ten [Step stopped] lines
  // and restarted the same step ten times -- a key that stops nothing and
  // says it stopped something. Esc means the whole agent task now, and the
  // queue survives it: a message typed mid-work is still delivered, a message
  // the operator asks for afterwards is still their own.
  const result = s.escAbort();
  if (!result) return;   // nothing running, nothing said
  // One short line per press: what stopped, and what the next press would stop.
  const left = store.getState()._taskRegistry.filter((t) => t.type === "bg-process").length;
  const next = left ? ` · ${left} background process${left === 1 ? "" : "es"} running, Esc stops the newest` : "";
  if (result.type === "agent-loop") {
    const detail = s.currentTool ? ` while ${s.currentTool}` : "";
    // The queue is still kept (see escAbort).
    s.addLine(chalk.yellow(`  [stopped the turn${detail}]`) + chalk.dim(next));
    s.setStreamText("");
    s.setAgentStatus("idle");
  } else if (result.type === "bg-process") {
    // Nothing here: the process's own "sh killed" ledger line says it, with
    // what is still running (ui/output.js printProcessEnd).
  } else {
    s.addLine(chalk.yellow(`  [stopped ${result.type}: ${result.label}]`) + chalk.dim(next));
  }
}

// Populate header lines BEFORE Ink render so first frame is complete
printHeader();

// Longest wait for the launcher to confirm its spinner stopped. It answers in
// a few ms; the cap only matters for a launcher that never answers.
const LAUNCHER_RELEASE_WAIT_MS = 500;

// Stop the launcher's splash spinner BEFORE clearing the screen, and wait
// until it says it has stopped.
//
// The launcher spawns us with the three standard streams inherited, so it
// cannot see our output: there is no pipe to watch. Its spinner repaints with
// a bare \r every 120 ms. "flint:ready" used to be sent after Ink's first
// render, so a tick landing between the clear below and that message wrote
// "loading..." onto the top line of the cleared screen, where Ink then drew
// its border on the same row (owner, 2026-10-02, intermittent). The launcher
// stops the interval first and answers "flint:released" after, so once the
// answer is here no tick can follow. The wait is capped: an older launcher
// never answers, and a missing answer must not hold the start.
//
// Sent only when there is a channel: run directly (`node src/index.js`,
// tests) there is no parent IPC and process.send is undefined, which is a
// normal way to start Flint and must not throw.
let carriedBulk = null;
if (process.send) {
  await new Promise((resolve) => {
    const done = () => { clearTimeout(timer); process.off("message", onMessage); resolve(); };
    const onMessage = (msg) => {
      if (!msg || msg.type !== "flint:released") return;
      // A restart of the same session brings /allow-all or /deny-all back
      // (restart.js). Set before the first turn can run; said once the UI is up.
      carriedBulk = carriedBulkPermission(msg);
      if (carriedBulk) bulkSetPermission(carriedBulk);
      done();
    };
    const timer = setTimeout(done, LAUNCHER_RELEASE_WAIT_MS);
    process.on("message", onMessage);
    process.send({ type: "flint:ready" });
  });
}

// Clear entire screen (remove launcher splash) before Ink takes over
if (cli.action !== "headless" && cli.action !== "check") {
  process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
}
const inkInstance = cli.action !== "headless" && cli.action !== "check"
  ? render(h(App, { store, onSubmit: handleInput, onAbort: handleAbort, onQuit: () => gracefulShutdown("ctrl-c"), onClipboard: readClipboardForInput, onRecallQueued: recallQueuedInput }), RENDER_OPTIONS)
  : null;
if (inkInstance) {
  setInkActive(true); // suppress stderr writes that corrupt Ink layout
  store.setState({ _inkClear: () => inkInstance.clear() });
}
if (inkInstance && cli.action !== "stdio" && !stdinIsRealTTY()) {
  watchForEmptyInput({
    onEmpty: () => {
      try { inkInstance.unmount(); } catch { /* already gone */ }
      process.stderr.write(NO_INPUT_MESSAGE + String.fromCharCode(10));
      process.exit(1);
    },
  });
}
if (mcpConfigProblem) {
  if (inkInstance) printWarning(mcpConfigProblem);
  else process.stderr.write(`[flint] ${mcpConfigProblem}
`);
}
if (carriedBulk) {
  printSystem(carriedBulk === "allow"
    ? "All tools -> allow, kept from before the restart (/reset-permissions turns it off)"
    : "All tools -> deny, kept from before the restart (/reset-permissions turns it off)");
}

// -- Graceful shutdown --

function gracefulShutdown(signal) {
  if (app.shuttingDown) return;
  app.shuttingDown = true;
  // Abort all registered tasks
  const aborted = store.getState().abortAll();
  if (aborted.length > 0) {
    process.stderr.write(`\n[Flint] Aborted ${aborted.length} task(s): ${aborted.map(t => t.label).join(", ")}\n`);
  }
  process.stderr.write("[Flint] Shutting down...\n");
  stopPlugins().catch(() => {});
  killAllChildren(2000);
  // Task-driven child agent: complete task on exit
  if (_agentTaskId) {
    try {
      const task = getTaskById(_agentTaskId);
      if (task && task.status === "in_progress") {
        completeTaskWithResult(_agentTaskId, "Agent completed task");
      }
    } catch {}
  }
  unregisterAgent(process.pid);
  // Cleanup sandbox container if running in docker mode
  try {
    import("./sandbox/backend.js").then(m => m.cleanupSandbox()).catch(() => {});
  } catch {}
  closeDb();
  const ss = store.getState();
  saveSession(ss.sessionId, sessionData(store)).finally(() => {
    setTimeout(() => process.exit(0), 500);
  });
}

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("exit", () => { if (!app.shuttingDown) killAllChildren(0); });

// -- Replay chat history on session load --
//
// The end of the session as it was on screen, from its chat log
// (ui/replay.js): the last lines, not the whole conversation, and not written
// to the log again. The message-based replay below is the fallback for a
// session without a chat log.

let replayedFromLog = 0;
if (store.getState().messages.length > 1) {
  try {
    const { replaySessionTail } = await import("./ui/replay.js");
    replayedFromLog = replaySessionTail(store, store.getState().sessionId);
  } catch {}
}
if (store.getState().messages.length > 1 && !replayedFromLog) {
  const { addLine } = store.getState();
  for (const m of store.getState().messages) {
    if (m.role === "user") {
      let text = typeof m.content === "string" ? stripTimeStamp(m.content) : "";
      if (!text) continue;
      // Strip injected plan/image registry blocks for cleaner display
      text = text.replace(/\[CURRENT PLAN\][\s\S]*?\n/g, "");
      text = text.replace(/\[Available pasted images:[\s\S]*?\]/g, "");
      text = text.trim();
      if (!text) continue;
      const short = text.length > 200 ? text.slice(0, 200) + "..." : text;
      userMsgLine(chalk.dim(short));
    } else if (m.role === "assistant" && m.content && !m.tool_calls?.length) {
      const text = m.content;
      const short = text.length > 300 ? text.slice(0, 300) + "..." : text;
      for (const line of short.split("\n")) {
        addIndented(INDENT, chalk.dim(line));
      }
    }
  }
  addLine(chalk.gray(" ---"));
  addLine("");
}




// -- Clipboard --

function readClipboardImage() {
  try {
    const ps = [
      "$ProgressPreference='SilentlyContinue';",
      "Add-Type -AssemblyName System.Windows.Forms;",
      "$i = [System.Windows.Forms.Clipboard]::GetImage();",
      "if ($i) {",
      "  $m = New-Object System.IO.MemoryStream;",
      "  $i.Save($m, [System.Drawing.Imaging.ImageFormat]::Png);",
      "  [Convert]::ToBase64String($m.ToArray())",
      "} else { Write-Output 'NO_IMAGE' }",
    ].join(" ");
    const encoded = Buffer.from(ps, "utf16le").toString("base64");
    const result = execFileSync("powershell", ["-NoProfile", "-EncodedCommand", encoded], {
      encoding: "utf-8",
      timeout: 10000,
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();
    if (result === "NO_IMAGE" || !result) return null;
    return result;
  } catch {
    return null;
  }
}

function readClipboard() {
  const base64 = readClipboardImage();
  if (base64) {
    const sizeKB = Math.round((base64.length * 3) / 4 / 1024);
    return { type: "image", data: base64, tag: `[img:${sizeKB}KB]` };
  }
  try {
    const text = execFileSync("powershell", ["-NoProfile", "-command", "$ProgressPreference='SilentlyContinue'; Get-Clipboard"], {
      encoding: "utf-8",
      timeout: 3000,
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();
    if (text) {
      const bytes = Buffer.byteLength(text);
      const display = bytes >= 1024 ? `${Math.round(bytes / 1024)}KB` : `${bytes}B`;
      return { type: "text", data: text, tag: `[text:${display}]` };
    }
  } catch {}
  return null;
}

// -- Clipboard into the input (Ctrl+V) --

/**
 * The clipboard for the input: a picture is saved to a temp file and numbered
 * (the input shows "[Image #n]"), text is returned as text.
 */
function readClipboardForInput() {
  const clip = readClipboard();
  if (!clip) return null;
  if (clip.type !== "image") return { type: "text", data: clip.data };
  const path = `${os.tmpdir()}/flint_clipboard_${Date.now()}.png`;
  try { writeFileSync(path, Buffer.from(clip.data, "base64")); trackTempFile(path); } catch {}
  const pasted = store.getState().pastedImages;
  const index = pasted.length + 1;
  store.setState({ pastedImages: [...pasted, { path, timestamp: Date.now(), index }] });
  return { type: "image", index, path, data: clip.data, bytes: Math.round((clip.data.length * 3) / 4) };
}

/** A message with pasted images: inlined up to 2 MB each, by path beyond that. */
async function sendWithImages(text, images) {
  const MAX_IMAGE_INLINE = 2 * 1024 * 1024;
  const parts = [];
  const notes = [];
  for (const img of images) {
    if (img.bytes <= MAX_IMAGE_INLINE) {
      parts.push({ type: "image_url", image_url: { url: `data:image/png;base64,${img.data}` } });
      notes.push(`[IMAGE #${img.index} saved to: ${img.path}]`);
    } else {
      notes.push(`[IMAGE #${img.index} saved to: ${img.path} (${(img.bytes / 1024 / 1024).toFixed(1)} MB). Too large to send inline; the file is on disk.]`);
    }
  }
  parts.push({ type: "text", text: [text, "", ...notes].join("\n") });
  const content = parts.length === 1 ? parts[0].text : parts;
  store.getState().incrementQueue();
  await withLock(async () => {
    store.getState().decrementQueue();
    try {
      await processMessage(content, null);
      await handlePendingAction();
    } catch (err) {
      if (err.name !== "AbortError") store.getState().addLine(chalk.red(`Error: ${err.message}`));
    }
  });
}

/**
 * Esc on an unread message: the newest one leaves the queue and comes back to
 * the input for editing (owner, 2026-10-01). Returns its text, or null when
 * the agent has already taken it.
 */
function recallQueuedInput() {
  const list = store.getState().queuedInputs || [];
  const last = list[list.length - 1];
  if (!last) return null;
  store.getState().takeQueuedInput(last.id);
  if (!bus.cancelPending(last.id)) return null;
  return last.edit || last.display;
}

// -- Handle user input --

async function handleInput(input, opts = {}) {
  const trimmed = input.trim();
  if (!trimmed) return;
  // What the history shows: the input with its paste/image tokens, when the
  // App expanded them for the model (ui/paste-tokens.js).
  const display = (opts.display || trimmed).trim();

  // Intercept permission confirmation responses
  const pending = store.getState().pendingConfirmation;
  if (pending) {
    const lower = trimmed.toLowerCase();
    if (lower === "y" || lower === "yes") {
      printConfirmResult("allow", pending.toolName, pending.argsText);
      pending.resolve("yes");
    } else if (lower === "a" || lower === "always") {
      printConfirmResult("always", pending.toolName, pending.argsText);
      pending.resolve("always");
    } else if (lower === "s" && pending.server) {
      printConfirmResult("server", pending.toolName, pending.argsText, pending.server);
      pending.resolve("server");
    } else {
      printConfirmResult("deny", pending.toolName, pending.argsText);
      pending.resolve("no");
    }
    return;
  }

  // Intercept pairing cancellation
  const pairingPending = store.getState().pendingPairing;
  if (pairingPending && trimmed.toLowerCase() === "c") {
    store.getState().clearPendingPairing();
    printSystem("Pairing cancelled.");
    return;
  }

  // "stop" -- abort current execution
  const lower = trimmed.toLowerCase();
  if (lower === "stop" || lower === "/stop") {
    if (app.abortController) {
      app.abortController.abort();
      const pending = bus.stats().pending;
      if (pending > 0) busFlush();
      store.getState().addLine(chalk.yellow(`\n  [Aborted by user${pending > 0 ? `, ${pending} queued dropped` : ""}]\n`));
    } else {
      store.getState().addLine(chalk.gray("  Nothing running."));
    }
    return;
  }

  const isBusy = isProcessing() || store.getState().processingCount > 0;

  // While busy, a message to the agent waits above the input until it is read
  // (takeQueuedMessages / the drain loop move it into the history then).
  // Commands and images still run at once, so they are echoed now.
  const deferEcho = isBusy && !isSlashCommand(trimmed) && !opts.images?.length;
  if (!deferEcho) userMsgLine(isBusy ? chalk.dim(display) : display);

  // Save to input history: the tokens, which the App expands again on send.
  if (trimmed) {
    store.getState().pushInputHistory((opts.history || display).trim());
  }

  // Images pasted with Ctrl+V travel with the message, so it cannot go
  // through the bus (which stores text); sent directly, as /paste did.
  if (opts.images?.length) {
    await sendWithImages(trimmed, opts.images);
    return;
  }

  // Supervisor toggle
  if (lower === "/supervisor" || lower === "/supervisor on") {
    setSupervisorEnabled(true);
    printSystem("Supervisor ON — watching tool calls, will inject hints");
    return;
  }
  if (lower === "/supervisor off") {
    setSupervisorEnabled(false);
    printSystem("Supervisor OFF");
    return;
  }

  // Exit
  if (lower === "exit" || lower === "/exit" || lower === "/quit") {
    await saveSession(store.getState().sessionId, sessionData(store));
    store.getState().addLine(chalk.gray(`Session saved: ${store.getState().sessionId}`));
    store.getState().addLine(chalk.gray("Bye!"));
    setTimeout(() => process.exit(0), 100);
    return;
  }

  // Handle /paste command (needs access to processMessage, so handled here not in commands.js)
  if (lower === "/paste" || lower.startsWith("/paste ")) {
    const text = trimmed.slice(6).trim() || "What is in this image?";
    store.getState().addLine(chalk.gray(" reading clipboard..."));
    const clip = readClipboard();
    if (!clip) {
      store.getState().addLine(chalk.red(" Clipboard is empty."));
      return;
    }
    store.getState().addLine(chalk.gray(` ${clip.tag}, sending...`));
    let msgContent;
    if (clip.type === "image") {
      const imgPath = `${(await import("node:os")).tmpdir()}/flint_clipboard_${Date.now()}.png`;
      const imgBytes = Math.round((clip.data.length * 3) / 4);
      const MAX_IMAGE_INLINE = 2 * 1024 * 1024; // 2 MB — inline as base64
      try {
        const { mkdirSync, writeFileSync } = await import("node:fs");
        // tmpdir already exists
        writeFileSync(imgPath, Buffer.from(clip.data, "base64"));
        trackTempFile(imgPath);
      } catch {}
      const pastedImages = store.getState().pastedImages;
      const imgIndex = pastedImages.length + 1;
      store.setState({ pastedImages: [...pastedImages, { path: imgPath, timestamp: Date.now(), index: imgIndex }] });

      if (imgBytes > MAX_IMAGE_INLINE) {
        // Large image: send only file path, do not inline base64
        const sizeMB = (imgBytes / 1024 / 1024).toFixed(1);
        store.getState().addLine(chalk.yellow(` large image (${sizeMB} MB), saved to file instead of inlining`));
        msgContent = `${text}\n\n[IMAGE #${imgIndex} saved to: ${imgPath} (${sizeMB} MB). Image is too large to send inline. The file is on disk if you need to reference it.]`;
      } else {
        // Normal image: inline as base64
        msgContent = [
          { type: "image_url", image_url: { url: `data:image/png;base64,${clip.data}` } },
          { type: "text", text: `${text}\n\n[IMAGE #${imgIndex} saved to: ${imgPath}]` },
        ];
      }
    } else {
      const textLines = clip.data.split("\n").length;
      const textBytes = Buffer.byteLength(clip.data);
      const isLarge = textLines >= 50 || textBytes >= 2048;

      if (isLarge) {
        // Large text: save to temp file, let model use read_file
        const tmpPath = `${(await import("node:os")).tmpdir()}/flint_clipboard_${Date.now()}.txt`;
        try {
          const { mkdirSync, writeFileSync } = await import("node:fs");
          // tmpdir already exists
          writeFileSync(tmpPath, clip.data, "utf-8");
          trackTempFile(tmpPath);
        } catch (e) {
          store.getState().addLine(chalk.red(` Failed to save clipboard: ${e.message}`));
          return;
        }
        const sizeDisplay = textBytes >= 1024 ? `${Math.round(textBytes / 1024)} KB` : `${textBytes} B`;
        store.getState().addLine(chalk.gray(` saved to ${tmpPath} (${sizeDisplay}, ${textLines} lines)`));
        const userNote = text !== "What is in this image?" ? text + "\n\n" : "";
        msgContent = `${userNote}[User pasted text from clipboard, saved as ${tmpPath} (${sizeDisplay}, ${textLines} lines). Use read_file to see the content.]`;
      } else {
        // Small text: inline as before
        msgContent = text !== "What is in this image?" ? text + "\n\n" + clip.data : clip.data;
      }
    }
    store.getState().incrementQueue();
    await withLock(async () => {
      store.getState().decrementQueue();
      try {
        await processMessage(msgContent, null);
        await handlePendingAction();
      } catch (err) {
        if (err.name !== "AbortError") {
          store.getState().addLine(chalk.red(`Error: ${err.message}`));
        }
      }
      store.getState().addLine("");
    });
    return;
  }

  // Handle /auto command (needs processMessage access)
  if (lower.startsWith("/auto ")) {
    const autoTask = trimmed.slice(6).trim();
    if (!autoTask) {
      store.getState().addLine(chalk.red('  Usage: /auto "build a REST API"'));
      return;
    }
    store.getState().addLine(chalk.cyan(`\n  [AUTO MODE] ${autoTask}\n`));
    const autoMaxIter = config.autoMaxIterations;
    const autoMaxCost = config.autoMaxCost;
    await withLock(async () => {
      try {
        await runAutoMode(autoTask, {
          processMessage,
          getStore: () => store,
          printSystem: (msg) => store.getState().addLine(chalk.cyan(`  ${msg}`)),
          printWarning: (msg) => store.getState().addLine(chalk.yellow(`  ${msg}`)),
          maxIterations: autoMaxIter,
          maxCost: autoMaxCost,
          isAborted: () => app.abortController?.signal?.aborted || false,
        });
      } catch (err) {
        if (err.name !== "AbortError") {
          store.getState().addLine(chalk.red(`  [AUTO] Error: ${err.message}`));
        }
      }
      store.getState().addLine("");
    });
    return;
  }

  // Handle /continue — resume auto mode on existing plan
  if (lower === "/continue") {
    const activeGoal = getActiveGoal();
    if (!activeGoal) {
      store.getState().addLine(chalk.gray("  No active plan to continue. Use /auto <task> to start one."));
      return;
    }
    const stats = getTaskStats(activeGoal.id);
    if (stats.pending === 0 && stats.in_progress === 0) {
      if (stats.total === 0) {
        // Empty plan (0/0) — model failed to create tasks. Re-send goal as regular message.
        store.getState().addLine(chalk.yellow(`  Plan has 0 tasks — re-sending goal as message.`));
        abandonGoal(activeGoal.id);
        await withLock(async () => {
          await processMessage(activeGoal.title);
        });
        return;
      }
      store.getState().addLine(chalk.gray(`  Plan "${activeGoal.title}" is already complete (${stats.done}/${stats.total} done).`));
      return;
    }
    store.getState().addLine(chalk.cyan(`\n  [CONTINUE] Resuming: ${activeGoal.title}\n`));
    await withLock(async () => {
      try {
        await runAutoMode(activeGoal.title, {
          processMessage,
          getStore: () => store,
          printSystem: (msg) => store.getState().addLine(chalk.cyan(`  ${msg}`)),
          printWarning: (msg) => store.getState().addLine(chalk.yellow(`  ${msg}`)),
          maxIterations: config.autoMaxIterations,
          maxCost: config.autoMaxCost,
          isAborted: () => app.abortController?.signal?.aborted || false,
          resume: true,
        });
      } catch (err) {
        if (err.name !== "AbortError") {
          store.getState().addLine(chalk.red(`  [AUTO] Error: ${err.message}`));
        }
      }
      store.getState().addLine("");
    });
    return;
  }

  // Try slash commands (through lock to prevent race with concurrent API messages)
  if (isSlashCommand(trimmed)) {
    await withLock(async () => {
      const handled = await tryHandleCommand(trimmed, store);
      if (!handled) {
        const cmd = trimmed.split(/\s/)[0];
        store.getState().addLine(chalk.red(`  Unknown command: ${cmd}`));
        store.getState().addLine(chalk.gray("  Type /help for available commands."));
      }
    });
    return;
  }

  // All messages go through bus — drain loop processes them sequentially
  const { id: busId } = bus.push({ channel: "user", content: trimmed, priority: bus.PRIORITY.USER, source: "tui", sessionId: store.getState().sessionId });
  if (isBusy) {
    // `edit` is what Esc puts back in the input: the tokens, not the preview.
    store.getState().addQueuedInput({ id: busId, display, edit: (opts.history || trimmed).trim() });
  } else {
    store.getState().setAgentStatus("thinking"); // show spinner immediately
  }
  busPush(); // notify drain loop
}

// -- Cleanup old clipboard temp files (older than 1 hour) --
try {
  const { readdirSync, statSync, unlinkSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const tmpDir = tmpdir();
  const now = Date.now();
  for (const f of readdirSync(tmpDir).filter((n) => n.startsWith("flint_clipboard_") && (n.endsWith(".txt") || n.endsWith(".png")))) {
    try {
      const fp = `${tmpDir}/${f}`;
      if (now - statSync(fp).mtimeMs > 3600000) unlinkSync(fp);
    } catch {}
  }
} catch {}

if (cli.action !== "headless") {
  // -- Start HTTP server (only for interactive and stdio modes) --

  const serverResult = startServer(config.port, store, async (content, name, sender) => {
  // All API messages go through bus — drain loop processes them
  const { id: busId } = bus.push({ channel: "api", content, priority: bus.PRIORITY.API, source: sender || name, sessionId: store.getState().sessionId });
  busPush(); // notify drain loop
  return waitForResult(busId);
}, {
  getAbortController: () => app.abortController,
  onStop: busFlush,
  getPlan: () => store.getState().plan,
  authMiddleware: app.securityApi?.authMiddleware || null,
  // --port means that port. See config.portExplicit.
  strictPort: config.portExplicit,
  onPairingRequest({ sessionId, pin, fromAddress, agentName, expiresAt }) {
    const safeName = agentName ? agentName.replace(/\s+/g, "_") : null;
    store.getState().setPendingPairing({ sessionId, pin, fromAddress, agentName: safeName, expiresAt });
    const who = safeName ? `${safeName}@${fromAddress}` : fromAddress;
    printWarning(`Pairing request from ${who} -- PIN: ${pin}`);
    // Auto-clear after expiry
    setTimeout(() => {
      const current = store.getState().pendingPairing;
      if (current && current.sessionId === sessionId) {
        store.getState().clearPendingPairing();
        printSystem("Pairing session expired.");
      }
    }, expiresAt - Date.now());
  },
  onPairingResult({ success, fromAddress, agentName, error }) {
    store.getState().clearPendingPairing();
    const safeName = agentName ? agentName.replace(/\s+/g, "_") : null;
    const who = safeName ? `${safeName}@${fromAddress}` : fromAddress;
    if (success) {
      printSystem(`Connection established with ${who}`);
    } else {
      printWarning(`Pairing failed from ${who}: ${error}`);
    }
  },
  onCommand: async (command) => {
    // /new, /clear, etc. — delegate to tryHandleCommand (same codepath as TUI)
    if (command.toLowerCase() === "/new") {
      await withLock(async () => {
        await tryHandleCommand("/new", store);
      });
      return "new session started";
    }
    // Handle /supervisor via HTTP
    if (command.toLowerCase() === "/supervisor on" || command.toLowerCase() === "/supervisor") {
      setSupervisorEnabled(true);
      return "Supervisor ON -- watching tool calls, will inject hints";
    }
    if (command.toLowerCase() === "/supervisor off") {
      setSupervisorEnabled(false);
      return "Supervisor OFF";
    }

    // Handle /clear via HTTP
    if (command.toLowerCase() === "/clear") {
      await withLock(async () => {
        const s = store.getState();
        s.resetSession(s.sessionId, [app.systemMessage]);
        s.clearDatasets();
        await saveSession(s.sessionId, sessionData(store));
      });
      return "context cleared";
    }
    // Handle /continue via HTTP
    if (command.toLowerCase() === "/continue") {
      const activeGoal = getActiveGoal();
      if (!activeGoal) return "no active plan to continue";
      const gStats = getTaskStats(activeGoal.id);
      if (gStats.pending === 0 && gStats.in_progress === 0) return "plan already complete";
      store.getState().addLine(chalk.cyan(`\n  [CONTINUE] Resuming: ${activeGoal.title}\n`));
      await withLock(async () => {
        await runAutoMode(activeGoal.title, {
          processMessage,
          getStore: () => store,
          printSystem: (msg) => store.getState().addLine(chalk.cyan(`  ${msg}`)),
          printWarning: (msg) => store.getState().addLine(chalk.yellow(`  ${msg}`)),
          maxIterations: config.autoMaxIterations,
          maxCost: config.autoMaxCost,
          isAborted: () => app.abortController?.signal?.aborted || false,
          resume: true,
        });
      });
      return "continue completed";
    }
    // Handle /auto via HTTP
    if (command.toLowerCase().startsWith("/auto ")) {
      const autoTask = command.slice(6).trim();
      if (!autoTask) return "usage: /auto <task>";
      store.getState().addLine(chalk.cyan(`\n  [AUTO MODE] ${autoTask}\n`));
      await withLock(async () => {
        await runAutoMode(autoTask, {
          processMessage,
          getStore: () => store,
          printSystem: (msg) => store.getState().addLine(chalk.cyan(`  ${msg}`)),
          printWarning: (msg) => store.getState().addLine(chalk.yellow(`  ${msg}`)),
          maxIterations: config.autoMaxIterations,
          maxCost: config.autoMaxCost,
          isAborted: () => app.abortController?.signal?.aborted || false,
        });
      });
      return "auto mode completed";
    }
    return withLock(async () => {
      const handled = await tryHandleCommand(command, store);
      return handled ? "ok" : "unknown command";
    });
  },
});

// Update port if server picked a different one (startServer returns a Promise)
// The banner is drawn before this resolves, so tell it now what was asked for.
// It used to print the default 3000 on an instance started with --port 3001,
// which is how a bench run reported a port it was not on.
app.actualPort = config.port;

if (serverResult && typeof serverResult.then === "function") {
  serverResult.then((result) => {
    if (result && result.error) {
      // Asked for a specific port and did not get it. Carrying on would mean
      // answering on a port nobody was told about, or not answering at all.
      process.stderr.write(`[flint] ${result.error}\n`);
      log.error("explicit port unavailable, exiting", { port: config.port });
      process.exit(1);
    }
    if (result && result.port) {
      app.actualPort = result.port;
      if (app.actualPort !== config.port) {
        store.getState().addLine(chalk.yellow(`  Port ${config.port} busy, using ${app.actualPort}`));
      }
      store.setState({ _port: app.actualPort });
    }
  });
} else if (serverResult && serverResult.port) {
  app.actualPort = serverResult.port;
  store.setState({ _port: app.actualPort });
}

  // -- Is there a newer Flint? (docs/self-update.md) --
  // In the background, at most once a day, never in the headless mode; one
  // line when there is. FLINT_UPDATE_CHECK=0 turns it off.
}
  if (cli.action !== "headless" && process.env.FLINT_UPDATE_CHECK !== "0") {
    setTimeout(async () => {
    try {
      const { checkForUpdate, installKind, updateNotice } = await import("./update.js");
      const dataDirPath = (await import("./data-dir.js")).homeStateDir();
      const root = config.projectRoot;
      const check = await checkForUpdate({
        root, current: pkg.version, kind: installKind(root),
        cacheFile: path.join(dataDirPath, "update-check.json"),
      });
      const notice = updateNotice(check);
      if (notice) store.getState().addLine(chalk.yellow(`  ${notice}`));
    } catch (err) {
      log.debug("update check failed", { error: err.message });
    }
  }, 4000).unref?.();
}

// Startup complete -- clear watchdog
clearStartupWatchdog();
log.info("Startup complete", { port: app.actualPort, pid: process.pid });

// Start background log collector (cleanup old sessions/logs)
startLogCollector();

// Register internal timers for Processes tab visibility
const CLEANUP_INTERVAL = parseInt(process.env.AGENT_CLEANUP_INTERVAL_MIN || "60", 10) * 60000;
store.getState().registerTimer({ id: "log-collector", name: "Log collector", intervalMs: CLEANUP_INTERVAL });
store.getState().registerTimer({ id: "schedule-watcher", name: "Schedule watcher", intervalMs: 30000 });

// -- Message Bus: setup; this session's half-done messages back, leftovers of
// earlier runs expired (see prepareQueueAtStart) --
store._bus = bus; // expose to message-handler for onCheckQueue
{
  const { recovered, expired } = bus.prepareQueueAtStart({ sessionId: store.getState().sessionId });
  if (recovered > 0) {
    store.getState().addLine(chalk.cyan(`  [bus] Recovered ${recovered} message(s) a crash left half done`));
  }
  if (expired > 0) {
    store.getState().addLine(chalk.gray(`  [bus] ${expired} message(s) left in the queue by an earlier run were not run`));
  }
}

// -- Load channel plugins --
loadPlugins(bus).catch(() => {});

// -- Schedule watcher: check for fired reminders every 30s --

const _scheduleWatcher = setInterval(() => {
  try {
    store.getState().updateTimerRun("schedule-watcher");
    // Update bus stats for StatusBar
    try { store.setState({ _busPending: bus.stats().pending }); } catch {}
    const due = getDueReminders();
    for (const task of due) {
      fireReminder(task.id, task.repeat);
      const repeatTag = task.repeat ? ` [repeats: ${task.repeat}]` : "";
      store.getState().addLine(chalk.cyan(`  [reminder #${task.id}] ${task.title}${repeatTag}`));
      // Push to both inbox (for prompt hint) and bus (for processing)
      pushInbox("reminder", task.title, "schedule");
      bus.push({ channel: "scheduler", content: task.title, priority: bus.PRIORITY.TASK, source: "schedule", metadata: { taskId: task.id, repeat: task.repeat } });
    }
  } catch {}
  // GC stale sessions every ~30 min (counter resets each run)
  if (!_scheduleWatcher._gcCounter) _scheduleWatcher._gcCounter = 0;
  if (++_scheduleWatcher._gcCounter >= 60) { // 60 * 30s = 30 min
    _scheduleWatcher._gcCounter = 0;
    try {
      const orphaned = gcStaleSessions(7);
      if (orphaned > 0) {
        log.info(`GC: orphaned ${orphaned} tasks from stale sessions`);
      }
    } catch {}
  }
}, 30000);
_scheduleWatcher.unref();

// -- Register in agent registry --

registerAgent({
  port: app.actualPort,
  sessionId: store.getState().sessionId,
  model: config.model,
  provider: config.provider,
  profile: app.activeProfile,
  pid: process.pid,
});

// -- Orphan protection: if spawned by parent, monitor parent health --

const parentPort = process.env.AGENT_PARENT_PORT;
if (parentPort && process.env.AGENT_PAIRING_SECRET) {
  const PARENT_CHECK_INTERVAL = 20000; // 20s
  const MAX_PARENT_MISSES = 3;
  let parentMisses = 0;

  const parentHeartbeat = setInterval(async () => {
    try {
      const res = await fetch(apiUrl(parentPort, "/status"), {
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) {
        parentMisses = 0;
        return;
      }
    } catch {}

    parentMisses++;
    if (parentMisses >= MAX_PARENT_MISSES) {
      clearInterval(parentHeartbeat);
      store.getState().addLine(chalk.red(`\n  Parent agent (port ${parentPort}) unreachable -- shutting down (orphan protection)\n`));
      await saveSession(store.getState().sessionId, sessionData(store));
      setTimeout(() => process.exit(0), 1000);
    } else {
      store.getState().addLine(chalk.yellow(`  Parent agent (port ${parentPort}) no response (${parentMisses}/${MAX_PARENT_MISSES})`));
    }
  }, PARENT_CHECK_INTERVAL);
}

// -- Task-driven child agent: claim task from SQLite, update on exit --
const _agentTaskId = process.env.AGENT_TASK_ID ? parseInt(process.env.AGENT_TASK_ID, 10) : null;
if (_agentTaskId) {
  try {
    const task = getTaskById(_agentTaskId);
    if (task) {
      claimTask(_agentTaskId, `agent@${app.actualPort}`, app.actualPort);
      log.info(`Child agent claimed task #${_agentTaskId}: ${task.title}`);
      store.getState().addLine(chalk.cyan(`  [task #${_agentTaskId}] ${task.title}`));
    } else {
      log.warn(`Task #${_agentTaskId} not found in SQLite`);
    }
  } catch (err) {
    log.error(`Failed to claim task #${_agentTaskId}: ${err.message}`);
  }
}

// -- Idle timeout: child agents auto-exit after inactivity --
const idleTimeoutSec = parseInt(process.env.AGENT_IDLE_TIMEOUT || "0", 10);
const { childBusy } = await import("./child-idle.js");
const isChildBusy = () => childBusy({
  processing: isProcessing(),
  processingCount: store.getState().processingCount,
  agentStatus: store.getState().agentStatus,
  abortController: app.abortController,
});
if (idleTimeoutSec > 0) {
  let _idleTimer = null;
  const resetIdle = () => {
    if (_idleTimer) clearTimeout(_idleTimer);
    _idleTimer = setTimeout(async () => {
      // Working is not idle. The timer was reset only when the store's
      // message count changed, and a turn writes its messages back at the
      // end: a child doing a research task shut itself down one minute in,
      // between two browser calls (2026-10-02, agent@3010). While a turn or
      // queued work is running, look again later.
      if (isChildBusy()) { resetIdle(); return; }
      store.getState().addLine(chalk.gray(`\n  Idle timeout (${idleTimeoutSec}s) — shutting down\n`));
      // Task-driven child agent: complete task on idle exit
      if (_agentTaskId) {
        try {
          const task = getTaskById(_agentTaskId);
          if (task && task.status === "in_progress") {
            completeTaskWithResult(_agentTaskId, "Agent completed task (idle exit)");
          }
        } catch {}
      }
      await saveSession(store.getState().sessionId, sessionData(store));
      setTimeout(() => process.exit(0), 500);
    }, idleTimeoutSec * 1000);
  };
  // Reset on every message processed, and whenever the agent's status moves
  // (a turn starting or ending counts as activity).
  store.subscribe((state, prev) => {
    if (state.messages.length !== prev.messages.length || state.agentStatus !== prev.agentStatus) resetIdle();
  });
  resetIdle(); // start initial timer
}
