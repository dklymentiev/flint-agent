import chalk from "chalk";
import { config } from "./config.js";
import { store } from "./store/index.js";
import { app } from "./app-state.js";
import { getArgValue } from "./cli.js";
import { initRegistry, registerMcpTools, registerMeshTools, registerTaskTools, registerDatasetTools, registerScheduleTools, registerInboxTools, registerPlugin, setMcpManagement } from "./tools/registry.js";
import { loadPlugins } from "./plugins/loader.js";
import { ensureOwnEnv } from "./tools/own-env.js";
import { setPluginContext } from "./tools/plugin-tools.js";
import { getSandboxMode } from "./sandbox/backend.js";
import { initPermissions, askOnboardingIfNeeded, getOnboardingState, getConfirmTimeoutMs } from "./tools/permissions.js";
import { whileWaitingForOperator } from "./startup-watchdog.js";
import { prepareHeadless } from "./headless-start.js";
import { initSecurity } from "./security/index.js";
import { initCommands } from "./commands/registry.js";
import { getSystemMessage } from "./agent/system-prompt.js";
import { fetchModelInfo } from "./api/client.js";
import { initLogger, createLogger } from "./logging/logger.js";
import { loadProfile } from "./profiles.js";
import { stdinIsRealTTY } from "./tty.js";
import { createTaskTools, formatPlanForPrompt } from "./tools/tasks.js";
// schedule-tools.js removed — reminders are now add_task with next_run/repeat
import { createInboxTools, handleInboxTool } from "./tools/inbox-tools.js";
import { datasetToolDefs, createDatasetHandlers } from "./tools/dataset.js";
import { syncPlanToStore } from "./tasks/queries.js";
import { setPricingSource, seedSessionSpend } from "./agent/usage.js";
import {
  generateSessionId,
  saveSession,
  loadSession,
  quarantineSession,
  listSessions,
  acquireSessionLock,
  releaseSessionLock,
} from "./sessions.js";
import { initOutput, printWarning } from "./ui/output.js";
import { formatToolArgsFull } from "./ui/header.js";
import { approvalArgLines, approvalFitsLive } from "./components/LiveZone.js";
import { promptAttentionStart, promptAttentionStop } from "./ui/prompt-attention.js";

// How often the MCP health check looks; the backoff itself is in mcp-client.js.
const MCP_HEALTH_TICK_MS = 10_000;

export function buildSystemMessage(profileName, sessionId) {
  app.profileConfig = loadProfile(profileName);
  // A host's own instructions (stdio mode, --system-prompt-file and friends)
  // come after the profile. They add to Flint's prompt rather than replace
  // it: without the core prompt the model would not know Flint's tools.
  const profileContent = [app.profileConfig.content, app.hostPrompt].filter(Boolean).join("\n\n");
  return getSystemMessage(sessionId || null, {
    profile: profileName,
    profileContent,
    datasets: store.getState().datasets,
  });
}

// ── Bootstrap phases ──

function initProfile() {
  const explicitProfile = getArgValue("--profile") || process.env.AGENT_PROFILE;
  app.activeProfile = explicitProfile || "generic";
  try {
    app.profileConfig = loadProfile(app.activeProfile);
  } catch {
    app.activeProfile = "generic";
    app.profileConfig = loadProfile(app.activeProfile);
  }
  app.systemMessage = null; // deferred until tools are registered
  return explicitProfile;
}

function initStore() {
  initOutput(store);
  initRegistry(store);
  initCommands(store);
  initPermissions({
    confirm: (toolName, args, opts = {}) => new Promise((resolve) => {
      // Announce the wait, so a prompt that needs the operator reaches one
      // rather than sitting in a window nobody is looking at. Start before the
      // prompt is stored and stop when it is answered — including on the
      // timeout path, where stop() runs from the same wrapped resolve.
      const attention = promptAttentionStart();
      let settled = false;
      let timer = null;
      const wrappedResolve = (answer) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        promptAttentionStop(attention);
        const current = store.getState().pendingConfirmation;
        if (current && current.toolName === toolName) {
          store.getState().clearPendingConfirmation();
        }
        resolve(answer);
      };
      // The question is shown in the live zone only (LiveZone confirmText) and
      // answered with one key; history gets one line with the answer
      // (printConfirmResult). It used to print a three-line block that stayed
      // in history for good (owner, 2026-10-01).
      // The whole command, never a cut one (ui/header.js formatToolArgsFull).
      const argsText = formatToolArgsFull(args);
      // Too long for the live zone: printed in full into the history, once.
      const argLines = approvalArgLines(argsText);
      if (!approvalFitsLive(argLines.length)) {
        store.getState().addLine(chalk.yellow(`  ? ${toolName} asks for approval, full command:`));
        for (const l of argLines) store.getState().addLine(l);
      }
      store.getState().setPendingConfirmation({ id: Date.now(), toolName, args, argsText, server: opts.server || null, resolve: wrappedResolve });
      // permissions.js gives up after its window; take the question off the
      // screen at the same moment, or the input would stay waiting for y/n.
      timer = setTimeout(() => wrappedResolve("timeout"), getConfirmTimeoutMs());
      timer.unref?.();
    }),
    // No timeout passed on purpose.
    //
    // This used to pass `timeout: 30000`, which overrode the 600 s the module
    // sets for itself — and the module's own comment explains at length why
    // 30 s was abandoned: it caused a retry-storm, because a prompt that gave up
    // after half a minute sent every denied tool straight back to the model,
    // which retried, which timed out again. The prompt text was then corrected
    // to read from getConfirmTimeoutMs() (68e1f21), which made the UI say "10m
    // timeout" while the answer was still being cut off at 30 s by this line.
    // Two sources of truth, and this was the wrong one. Leaving it unset lets
    // permissions.js own the number, which is what the fix in 68e1f21 assumed
    // was already true.
  });
  try {
    app.securityApi = initSecurity(store, config);
  } catch (err) {
    console.error(`[security] Outer init failed: ${err.message}\n${err.stack}`);
  }
}

/**
 * The one onboarding question, on a fresh home.
 *
 * Asked here and nowhere else, before the session takes any work, because the
 * level it records governs the guard registered a few lines above in initStore.
 * Asking later would mean the first turn of a first run was decided by a
 * default the operator had not been asked to accept.
 *
 * Backlog item 13. It used to be one readline line — a heading, three bracketed
 * options and "pick s, n or p", all on one row — and on 2026-09-30 11:05 the
 * owner read it as a wall of text and did not know what was being asked. It is
 * now a menu with a heading, the three options one per line each with a plain
 * sentence of what it means, the default marked and highlighted, arrows and
 * Enter to choose and a letter still accepted.
 *
 * The menu is rendered with ink, like everything else on screen, so it is in
 * colour and takes the keyboard the operator is already holding. ink is
 * imported here rather than at the top of the file so a headless run never
 * loads React: this is the only thing in bootstrap that needs it.
 *
 * The "already answered" check happens BEFORE anything is rendered or any
 * interface is taken over the terminal — otherwise the menu would be painted
 * over the top of a normal session start on every run after the first.
 *
 * Non-interactive stdin (a pipe, CI, a test) is still not asked, and the
 * documented default applies. That direction of failing is deliberate: the
 * level nobody chose is never written on their behalf.
 */
export async function initOnboarding() {
  // A --headless run has nobody to answer. Under sudo the process may still
  // hold a pseudoterminal, so the isTTY check below is not enough: the menu
  // was drawn, the watchdog countdown was lifted by whileWaitingForOperator,
  // and the run waited for a key that nobody could press. Ask only
  // when a person is actually there.
  if (config.headless) return;
  // Not process.stdin.isTTY alone: index.js fakes that for ink when stdin is a
  // pipe or /dev/null, and the menu then waited for keys that could not come.
  if (!stdinIsRealTTY()) return;
  // Asked on the very first run only. See the note above.
  if (getOnboardingState().asked) return;
  // No startup countdown while the operator reads the question.
  await whileWaitingForOperator(askCarefulLevel);
}

async function askCarefulLevel() {
  // Declared out here, not inside the try: the try only covers rendering, and
  // the answer is read after it. A `let answer` inside the block would be out
  // of scope at the confirm below and every run would silently answer null.
  let answer = null;
  let instance = null;
  try {
    const [{ render }, { CarefulMenu }, { createElement: h }] = await Promise.all([
      import("ink"),
      import("./components/CarefulMenu.js"),
      import("react"),
    ]);

    // One promise for the whole question, answered by whichever way the menu
    // closes. `answer` stays null unless the menu reports a choice, which is
    // what makes Esc and a crash both mean "not answered".
    let resolveAnswer;
    const answered = new Promise((r) => { resolveAnswer = r; });

    instance = render(
      h(CarefulMenu, {
        // askOnboardingIfNeeded still owns validity and persistence, so there
        // is one place that decides what an answer is worth. The menu only
        // reports which option was chosen.
        onSelect: (level) => { answer = level; resolveAnswer(); },
        onCancel: () => resolveAnswer(),
      }),
      { exitOnCtrlC: false },
    );
    // Either way, both promises settle on the same event, so the menu is never
    // left holding the terminal after this returns.
    await Promise.race([answered, instance.waitUntilExit()]);
  } catch (err) {
    // A first-run question must never be the reason Flint does not start.
    console.error(`[onboarding] question not shown: ${err.message}`);
  } finally {
    // The menu must let go of stdin before the session's own ink instance is
    // created a few steps later in index.js. Two ink instances reading the same
    // terminal both get the keystrokes, so arrows and letters land in the wrong
    // place roughly half the time — and the leftover listener is one of the
    // per-call AbortSignal-style listeners that once leaked. Unmounting
    // here is what makes the question a moment rather than a second owner of
    // the keyboard.
    try { instance?.unmount(); } catch { /* already gone */ }
  }

  // askOnboardingIfNeeded owns validity and persistence, so there is one place
  // that decides what an answer is worth: parseLevelAnswer refuses anything
  // unknown, and a refused or absent answer is not saved, so the question comes
  // back next start and the documented default applies meanwhile.
  await askOnboardingIfNeeded({ confirm: async () => answer });
}

function initTools() {
  const { tools: taskTools, handlers: taskHandlers } = createTaskTools({
    getStore: () => store,
  });
  registerTaskTools(taskTools, taskHandlers);

  const inboxTools = createInboxTools();
  registerInboxTools(inboxTools, { check_inbox: (args) => handleInboxTool("check_inbox", args) });

  registerDatasetTools(datasetToolDefs, createDatasetHandlers(store));
}

async function initMesh() {
  if (config.memoryUrl) {
    try {
      const { tools: meshTools, handlers: meshHandlers } = await import("./tools/mesh.js");
      registerMeshTools(meshTools, meshHandlers);
    } catch {}
  }
}

function initMcp() {
  app.mcpReady = false;
  if (!config.mcpServers) {
    app.mcpStatusList = [];
    // Nothing to load is loaded. Left false, every API message waited the
    // full 15 s for tools that were never coming (every benchmark task).
    app.mcpReady = true;
    return;
  }

  // Parse server names immediately for "connecting..." display in header
  try {
    const names = Array.isArray(config.mcpServers)
      ? config.mcpServers.map(s => s.name)
      : config.mcpServers.split(",").map(s => s.split("|")[0].trim()).filter(Boolean);
    app.mcpStatusList = names.map(name => ({ name, tools: 0, ok: false, connecting: true }));
  } catch {
    app.mcpStatusList = [];
  }

  // Connect in background — TUI already visible
  (async () => {
    try {
      const { connectMcpServers, disconnectServer, reconnectServer, getServerStatus, autoReconnectTick } = await import("./mcp-client.js");
      const { tools: mcpTools, handlers: mcpHandlers, results } = await connectMcpServers(config.mcpServers);
      registerMcpTools(mcpTools, mcpHandlers, results);
      app.mcpStatusList = results;
      app.mcpReady = true;
      setMcpManagement({
        getServerStatus: () => getServerStatus(config.mcpServers),
        disconnect: disconnectServer,
        reconnect: (name) => reconnectServer(name, config.mcpServers),
      });
      app.systemMessage = buildSystemMessage(app.activeProfile);
      // Show per-server results
      for (const mc of results) {
        if (mc.ok) {
          store.getState().addLine(chalk.green(`  mcp: ${mc.name} connected (${mc.tools} tools)`));
        } else {
          store.getState().addLine(chalk.yellow(`  mcp: ${mc.name} -- ${mc.error || "failed"}`));
        }
      }

      // MCP health check + auto-reconnect. The ticks are short so that a
      // backoff delay is kept to within a few seconds; what is retried, when,
      // and what is given up on is decided in mcp-client.js autoReconnectTick.
      const mcpHealthInterval = setInterval(async () => {
        try {
          const events = await autoReconnectTick(config.mcpServers);
          for (const ev of events) {
            if (ev.type === "connected") {
              const result = ev.result;
              registerMcpTools(result.tools ? [result] : [], result.handlers || {}, [result]);
              app.systemMessage = buildSystemMessage(app.activeProfile);
              store.getState().addLine(chalk.green(`  mcp: ${ev.name} reconnected (${result.toolCount || 0} tools)`));
            } else if (ev.type === "fatal") {
              store.getState().addLine(chalk.red(`  mcp: ${ev.name} cannot connect until its configuration is fixed, not retrying: ${ev.error}`));
            } else if (ev.type === "backoff") {
              store.getState().addLine(chalk.yellow(`  mcp: ${ev.name} reconnect failed: ${ev.error} (next try in ${Math.round(ev.delayMs / 1000)}s or later)`));
            }
          }
        } catch {}
      }, MCP_HEALTH_TICK_MS);
      mcpHealthInterval.unref(); // don't prevent process exit
    } catch (err) {
      app.mcpStatusList = [{ name: "mcp", tools: 0, ok: false, error: err.message }];
      store.getState().addLine(chalk.yellow(`  MCP: ${err.message}`));
      // Loading is over, it failed. Waiting on it would only delay every message.
      app.mcpReady = true;
    }
  })();
}

async function initPlugins() {
  // The same context for a plugin installed later from the conversation.
  setPluginContext({ config, store });
  const pluginResult = await loadPlugins();
  for (const plugin of pluginResult.loaded) {
    try {
      if (plugin.init) await plugin.init({ config, store });
      registerPlugin(plugin);
    } catch (err) {
      pluginResult.errors.push({ name: plugin.name, error: err.message });
    }
  }
  if (pluginResult.errors.length) {
    for (const e of pluginResult.errors) {
      printWarning(`Plugin ${e.name}: ${e.error}`);
    }
  }
}

async function initSystemMessage() {
  try {
    const { prefetchAgentMemory } = await import("./agent/system-prompt.js");
    await prefetchAgentMemory();
  } catch {}
  app.systemMessage = buildSystemMessage(app.activeProfile);
}

async function initSession(cli, explicitProfile) {
  store.setState({ _version: cli._version, _port: config.port, _profile: app.activeProfile });

  let initialMessages = null;
  let initialInputHistory = [];

  function restoreProfile(data) {
    if (!explicitProfile && data.profile) {
      app.activeProfile = data.profile;
      try {
        app.profileConfig = loadProfile(app.activeProfile);
        app.systemMessage = buildSystemMessage(app.activeProfile);
      } catch {}
    }
    store.setState({ _profile: app.activeProfile });
    store.getState().setProfile(app.activeProfile);
  }

  async function restoreSession(sessionId) {
    let data;
    try {
      data = await loadSession(sessionId);
    } catch (err) {
      if (err.code === "SESSION_CORRUPT") {
        // Keep what is on disk: a caller that starts an empty session under
        // this id would otherwise overwrite the only copy on its first save.
        const kept = await quarantineSession(sessionId);
        process.stderr.write(`[flint] ${err.message}. Kept as ${kept}; starting without it.\n`);
      }
      throw err;
    }
    if (data.messages?.[0]?.role === "system") {
      data.messages[0] = app.systemMessage;
    }
    const s = store.getState();
    s.setSession(sessionId, data.messages, data.inputHistory || []);
    s.setPlan(data.plan || null);
    s.setLastSummary(data.lastSummary || null);
    if (data.pastedImages) store.setState({ pastedImages: data.pastedImages });
    // Restore session cost — budget tracks across restarts. The ledger
    // is told too, and it is the one the session ceiling is enforced against:
    // a resumed session that starts the count at zero has no ceiling.
    if (data.sessionCost) {
      store.setState({
        sessionCost: data.sessionCost,
        sessionPromptTokens: data.sessionPromptTokens || 0,
        sessionCompletionTokens: data.sessionCompletionTokens || 0,
      });
      seedSessionSpend(data.sessionCost);
    }
    restoreProfile(data);
    initialMessages = data.messages;
    initialInputHistory = data.inputHistory || [];
  }

  if (cli.action === "last") {
    const sessions = await listSessions();
    // The newest session that can be read. A damaged file (a half-written
    // save, a hand edit) used to throw out of bootstrap as a bare stack trace;
    // it is skipped with one line, and with none readable Flint starts fresh.
    for (const s of sessions) {
      try {
        await restoreSession(s.id);
        break;
      } catch (err) {
        console.error(chalk.yellow(`Session "${s.id}" could not be read (${err.message}); skipped.`));
      }
    }
  }

  if (cli.action === "resume") {
    try {
      await restoreSession(cli.id);
    } catch (err) {
      console.error(chalk.red(err?.code === "SESSION_CORRUPT"
        ? `Session "${cli.id}" is corrupt; the file was kept as .corrupt.`
        : err?.code === "ENOENT"
          ? `Session "${cli.id}" not found.`
          : `Session "${cli.id}" could not be read: ${err.message}`));
      process.exit(1);
    }
  }

  // Headless can resume a session by --session <id>. The flag is parsed in
  // cli.js for the headless branch; cli.id is set only when the operator asked
  // for it. The lock is taken on cli.id BEFORE restore, so two headless runs
  // that name the same id contend on the same lock instead of each generating
  // a fallback timestamp id and never meeting. An existing session is
  // continued, a missing one is started fresh (a headless run naming an
  // unknown id is not fatal — it creates it).
  if (cli.action === "headless" && cli.id) {
    try {
      await acquireSessionLock(cli.id);
      app.lockOwned = true;
    } catch (err) {
      if (config.headless) {
        process.stderr.write("[headless] " + err.message + "\n");
        process.exit(1);
      }
      console.error(chalk.red(err.message));
    }
    try {
      await restoreSession(cli.id);
    } catch {
      // Unknown session: fall through to the new-session branch below, but
      // keep the lock we just took on cli.id — the new-session branch will
      // set the store session id to cli.id so the lock matches the file.
      store.getState().setSession(cli.id, [app.systemMessage], []);
      store.getState().setProfile(app.activeProfile);
    }
  }

  // stdio mode: the host names the session. Its id is kept as given, and an
  // existing one is continued whichever flag named it: a host decides between
  // --session-id and --resume from its own records, and a wrong guess must
  // not cost the conversation (some CLIs refuse both ways, and their hosts
  // carry workarounds for that).
  if (cli.action === "stdio" && cli.sessionId) {
    try {
      await restoreSession(cli.sessionId);
    } catch {
      store.getState().setSession(cli.sessionId, [app.systemMessage], []);
      store.getState().setProfile(app.activeProfile);
    }
  }

  if (!store.getState().sessionId) {
    const newId = generateSessionId();
    store.getState().setSession(newId, [app.systemMessage], []);
    store.getState().setProfile(app.activeProfile);
    listSessions().then(sessions => {
      if (sessions.length) {
        return loadSession(sessions[0].id).then(data => {
          if (data.inputHistory?.length) {
            store.setState({ inputHistory: data.inputHistory });
          }
        });
      }
    }).catch(() => {});
  }

  // Acquire an exclusive lock on the session. Two processes targeting the
  // same id would otherwise both write <id>.json and silently clobber each
  // other's history (the ids from generateSessionId are second-precision
  // timestamps, so a parallel pair collides by design). A live holder refuses
  // the second writer; a dead holder's lock is recovered.
  //
  // Headless + --session already locked and set its id above, so skip the
  // generic lock here to avoid acquiring a second lock file on a different
  // path.
  const sessionIdToLock = store.getState().sessionId;
  if (!(cli.action === "headless" && cli.id)) {
    try {
      await acquireSessionLock(sessionIdToLock);
    } catch (err) {
      if (config.headless) {
        process.stderr.write("[headless] " + err.message + "\n");
        process.exit(1);
      }
      console.error(chalk.red(err.message));
    }
  }

  store.getState().setModel(config.model);
  store.getState().setProvider(config.provider);

  return { initialMessages, initialInputHistory };
}

async function initWorkspace() {
  const sessionId = store.getState().sessionId;
  if (config.workdirBase) {
    config.workdir = config.workdirBase;
  } else if (config.workdir) {
    // Already set by enterCwd() for --headless --cwd: keep the task repo as
    // the write target so write_file / edit_file land there.
    // initWorkspace must not clobber this. See headless-start.js:enterCwd.
  } else {
    config.workdir = (await import("node:path")).default.join(config.sessionsDir, sessionId, "workspace");
  }
  await import("node:fs").then(fs => fs.promises.mkdir(config.workdir, { recursive: true }));
  process.env._FLINT_WORKDIR = config.workdir;

  initLogger({ sessionsDir: config.sessionsDir, sessionId });
  return createLogger("main");
}

// ── Main bootstrap ──

export async function bootstrap(cli, pkg) {
  const _bootTimes = [];
  const _t = (label) => _bootTimes.push([label, performance.now()]);

  _t("start");
  // First, before anything asks or reads the working directory. index.js has
  // already done this; it is repeated here so that the order is a property of
  // bootstrap() itself: initOnboarding() below must see the headless flag, and
  // initSystemMessage() must print --cwd, not the directory Flint is installed
  // in. Idempotent, and a no-op unless the run is headless.
  prepareHeadless(cli);
  // Headless mode: the host's instructions and local MCP config, the same way
  // stdio mode gets them. Without this, a headless launch cannot override its
  // identity (--system-prompt) or load servers from .mcp.json in --cwd: the
  // hostPromptFrom/mcpConfigPath calls lived only in index.js's stdio branch,
  // so bootstrap() called directly by tests or embedded callers never saw them.
  // An instructions file that is not there or a .mcp.json that is not JSON ends
  // the launch with one line and exit code 2, as it does in stdio mode
  // (launch-identity.js), not with a stack trace out of bootstrap().
  if (cli.action === "headless") {
    const { launchIdentityOrExit } = await import("./launch-identity.js");
    const identity = launchIdentityOrExit(cli, config.mcpServers);
    app.hostPrompt = identity.hostPrompt;
    config.mcpServers = identity.mcpServers;
  }
  const explicitProfile = initProfile();
  _t("initProfile");
  // Before initStore, and that ordering is the entire point.
  //
  // initStore is what registers the command guard, and the guard reads the
  // level once, at registration. Asked afterwards, the answer is recorded and
  // consulted by nothing for the rest of the session: the question would look
  // like it had worked and change no prompt at all.
  await initOnboarding();
  _t("initOnboarding");
  initStore();
  _t("initStore");
  initTools();
  _t("initTools");
  await initMesh();
  _t("initMesh");
  initMcp();
  _t("initMcp");
  await initPlugins();
  _t("initPlugins");
  // Not awaited: making the venv takes seconds, and the first shell command
  // waits on the same promise anyway. Started here so it is usually ready.
  if (getSandboxMode() !== "docker") ensureOwnEnv();
  await initSystemMessage();
  _t("initSystemMessage");

  cli._version = pkg.version;
  const { initialMessages, initialInputHistory } = await initSession(cli, explicitProfile);
  _t("initSession");

  const log = await initWorkspace();
  _t("initWorkspace");

  syncPlanToStore(store);
  _t("syncPlan");

  // The ledger prices a call itself only when the provider reported no cost.
  // It reads the rate card from here rather than importing the store, so the
  // accounting stays testable on its own.
  setPricingSource(() => store.getState().pricing);

  fetchModelInfo(config.model).then(modelInfo => {
    if (modelInfo) store.getState().setPricing(modelInfo);
  }).catch(() => {});
  _t("fetchModelInfo");

  log.info("boot-timings", Object.fromEntries(_bootTimes.map(([k, v]) => [k, Math.round(v)])));
  log.info(`Flint starting`, { port: config.port, model: config.model, profile: app.activeProfile });

  return { log, initialMessages, initialInputHistory, explicitProfile };
}
