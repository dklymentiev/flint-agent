// All slash commands implementation
import chalk from "chalk";
import { readFileSync } from "node:fs";
import { config } from "../config.js";
import {
  generateSessionId,
  saveSession,
  loadSession,
  listSessions,
} from "../sessions.js";
import { getSystemMessage } from "../agent/system-prompt.js";
import { clearDigest } from "../memory/conversation-digest.js";
import { clearSessionFacts } from "../memory/session-facts.js";
import { getPermissionMap, setPermission, resetSessionOverrides, bulkSetPermission } from "../tools/permissions.js";
import { getMemoryStats, listRecentMemories, clearAllMemories } from "../memory/store.js";
import { updateMemoryMd } from "../memory/markdown.js";
import { loadProfile, listProfiles as listProfileNames } from "../profiles.js";
import { formatPlanForPrompt } from "../tools/tasks.js";
import {
  getActiveGoal, listGoals, getTasksByGoal, getTaskStats,
  getDashboard, goalToPlan, syncPlanToStore, abandonAllActiveGoals,
} from "../tasks/queries.js";
import { listAgents } from "../registry.js";
import { getMcpServerStatus, mcpDisconnect, mcpReconnect, getLoadedPlugins, unregisterPlugin } from "../tools/registry.js";
import { activatePlugin } from "../tools/plugin-tools.js";
import { join as pathJoin } from "node:path";
import { installPlugin, uninstallPlugin } from "../plugins/manager.js";
import { listInstalledPlugins, getPluginsDir } from "../plugins/loader.js";
import { rewind, rewindAll, getCheckpointStack, clearCheckpoints } from "../tools/checkpoint.js";
import { printTable } from "../ui/output.js";
import * as bus from "../bus/index.js";
import { notify as busPush } from "../bus/drain-loop.js";
import { apiUrl } from "../api/address.js";

export function registerCommands(store) {
  function log(text) {
    store.getState().addLine(text);
  }

  const commands = {
    async "/help"() {
      log("");
      log(chalk.cyan("  Commands:"));
      log(chalk.white("  /sessions") + chalk.gray("  -- list saved sessions"));
      log(chalk.white("  /resume") + chalk.gray("   -- pick a recent session to continue (or /resume <id>)"));
      log(chalk.white("  /spend") + chalk.gray("    -- tokens per call: economy, normal, generous"));
      log(chalk.white("  /update") + chalk.gray("   -- install a newer Flint and restart, same session"));
      log(chalk.white("  /load <id>") + chalk.gray(" -- load a session"));
      log(chalk.white("  /new") + chalk.gray("      -- start new session"));
      log(chalk.white("  /clear") + chalk.gray("    -- clear context (keep session)"));
      log(chalk.white("  /queue") + chalk.gray("    -- list queued messages"));
      log(chalk.white("  /later <q>") + chalk.gray(" -- queue a question for later"));
      log(chalk.white("  /paired") + chalk.gray("   -- programs paired with the API (/paired revoke <name>)"));
      log(chalk.white("  /careful") + chalk.gray("  -- how often Flint asks: safe, normal, permissive"));
      log(chalk.white("  /ps") + chalk.gray("       -- background processes"));
      log(chalk.white("  /logs <id>") + chalk.gray(" -- last output of a background process"));
      log(chalk.white("  /kill <id>") + chalk.gray(" -- stop a background process (/kill all)"));
      log(chalk.white("  /tools [n]") + chalk.gray(" -- last n tool calls"));
      log(chalk.white("  /sys") + chalk.gray("      -- model, cost, context, MCP, session"));
      log(chalk.white("  /plan") + chalk.gray("     -- show current task plan"));
      log(chalk.white("  /tasks") + chalk.gray("    -- task dashboard (SQLite)"));
      log(chalk.white("  /continue") + chalk.gray(" -- resume unfinished auto work"));
      log(chalk.white("  /rewind") + chalk.gray("   -- undo last file change"));
      log(chalk.white("  /rewind N") + chalk.gray(" -- undo last N changes"));
      log(chalk.white("  /rewind all") + chalk.gray(" -- undo all changes this session"));
      log(chalk.white("  /model") + chalk.gray("    -- show current AI model"));
      log(chalk.white("  /provider") + chalk.gray(" -- show/switch LLM provider"));
      log(chalk.white("  /key") + chalk.gray("      -- manage API keys"));
      log(chalk.white("  /profile") + chalk.gray("  -- switch agent profile"));
      log(chalk.white("  /agents") + chalk.gray("   -- list running agent instances"));
      log(chalk.white("  /mcp") + chalk.gray("      -- manage MCP server connections"));
      log(chalk.white("  /paste") + chalk.gray("    -- send clipboard image to AI"));
      log(chalk.white("  /copy") + chalk.gray("     -- copy chat output to clipboard"));
      log(chalk.white("  /restart") + chalk.gray("  -- restart with updated code"));
      log(chalk.white("  /stats") + chalk.gray("    -- show current session info"));
      log(chalk.white("  /budget") + chalk.gray("   -- show session budget & spending"));
      log(chalk.white("  /stop") + chalk.gray("     -- abort running agent"));
      log(chalk.white("  /memory") + chalk.gray("   -- show persistent memory stats"));
      log(chalk.white("  /memory clear") + chalk.gray(" -- clear all memories"));
      log(chalk.white("  /permissions") + chalk.gray(" -- show tool permission map"));
      log(chalk.white("  /allow <t>") + chalk.gray(" -- allow a tool without confirmation"));
      log(chalk.white("  /deny <t>") + chalk.gray("  -- deny a tool completely"));
      log(chalk.white("  /confirm <t>") + chalk.gray(" -- require confirmation for a tool"));
      log(chalk.white("  /allow-all") + chalk.gray("   -- allow all tools (YOLO mode)"));
      log(chalk.white("  /deny-all") + chalk.gray("    -- deny all tools"));
      log(chalk.white("  /reset-permissions") + chalk.gray(" -- reset to defaults"));
      log(chalk.white("  /auto <task>") + chalk.gray(" -- run task autonomously"));
      log(chalk.white("  /plugins") + chalk.gray("  -- list installed plugins"));
      log(chalk.white("  /install <p>") + chalk.gray(" -- install a plugin"));
      log(chalk.white("  /uninstall <p>") + chalk.gray(" -- remove a plugin"));
      log(chalk.white("  /next") + chalk.gray("     -- next page of last dataset"));
      log(chalk.white("  /prev") + chalk.gray("     -- previous page of last dataset"));
      log(chalk.white("  /page N") + chalk.gray("   -- jump to page N (or /page <name> N)"));
      log(chalk.white("  exit") + chalk.gray("      -- quit"));
      log("");
      log(chalk.cyan("  Keys:"));
      log(chalk.white("  Alt+V") + chalk.gray("     -- paste a picture (or text) from the clipboard into the input as [Image #N]"));
      log(chalk.gray("              Ctrl+V is the terminal's own paste: with a picture in the clipboard it sends nothing."));
      log(chalk.white("  Esc") + chalk.gray("       -- clear the input / stop the turn / stop background processes, newest first"));
      log(chalk.white("  Ctrl+C") + chalk.gray("    -- stop the turn; twice within 2 s exits"));
      log("");
      log(chalk.gray("  Flint is free and open source: https://klymentiev.com/projects/flint"));
      log("");
      log(chalk.cyan("  Stop agent:"));
      log(chalk.white("  Escape") + chalk.gray("      -- stop the current task, keep the queue"));
      log(chalk.white('  "stop"') + chalk.gray("      -- type and press Enter to abort"));
      log(chalk.white("  POST /stop") + chalk.gray("  -- HTTP endpoint"));
      log("");
      log(chalk.cyan("  Shortcuts:"));
      log(chalk.white("  Ctrl+U") + chalk.gray("  -- clear input line"));
      log(chalk.white("  Ctrl+W") + chalk.gray("  -- delete last word"));
      log(chalk.white("  Up/Down") + chalk.gray(" -- input history"));
      log("");
    },

    async "/sessions"() {
      const sessions = await listSessions();
      const s = store.getState();
      if (!sessions.length) {
        log(chalk.gray("  No sessions."));
      } else {
        log("");
        for (const sess of sessions) {
          const marker = sess.id === s.sessionId ? chalk.green(" <") : "";
          log(`  ${chalk.yellow(sess.id)}  ${chalk.gray(sess.model)}  ${sess.preview}${marker}`);
        }
        log("");
      }
    },

    async "/load"(arg) {
      const id = (arg || "").trim();
      if (!id) {
        log(chalk.red("  Usage: /load <session-id>"));
        return;
      }
      try {
        const data = await loadSession(id);
        // Restore working directory BEFORE rebuilding system prompt so project
        // auto-detection in getSystemMessage reflects the loaded session's CWD,
        // not the current one. If the saved cwd no longer exists (renamed/
        // deleted), warn and keep the current cwd.
        if (data.cwd && data.cwd !== process.cwd()) {
          const { existsSync } = await import("node:fs");
          const { dirname } = await import("node:path");
          if (existsSync(data.cwd)) {
            try {
              process.chdir(data.cwd);
              log(chalk.gray(`  cwd → ${data.cwd}`));
            } catch (err) {
              log(chalk.yellow(`  warn: could not chdir to ${data.cwd}: ${err.message}`));
            }
          } else {
            // Structure changed — walk up to find closest existing ancestor.
            let ancestor = dirname(data.cwd);
            while (ancestor && ancestor !== dirname(ancestor) && !existsSync(ancestor)) {
              ancestor = dirname(ancestor);
            }
            if (ancestor && existsSync(ancestor)) {
              try {
                process.chdir(ancestor);
                log(chalk.yellow(`  warn: saved cwd gone: ${data.cwd}`));
                log(chalk.gray(`  cwd → ${ancestor} (closest existing ancestor)`));
              } catch {
                log(chalk.yellow(`  warn: saved cwd gone: ${data.cwd}. staying in ${process.cwd()}`));
              }
            } else {
              log(chalk.yellow(`  warn: saved cwd gone: ${data.cwd}. staying in ${process.cwd()}`));
            }
          }
        }
        if (data.messages?.[0]?.role === "system") {
          data.messages[0] = getSystemMessage(id);
        }
        const s = store.getState();
        s.setSession(id, data.messages, data.inputHistory || []);
        s.setPlan(data.plan || null);
        s.setLastSummary(data.lastSummary || null);
        if (data.pastedImages) store.setState({ pastedImages: data.pastedImages });
        if (data.profile) {
          s.setProfile(data.profile);
          store.setState({ _profile: data.profile });
        }
        const userMsgs = data.messages.filter((m) => m.role === "user").length;
        const { loadSessionFacts } = await import("../memory/session-facts.js");
        const facts = loadSessionFacts(id);
        const factsInfo = facts.length ? `, ${facts.length} facts` : "";
        // Where the conversation got to, as it was on screen (ui/replay.js).
        // Never the reason a load fails: the session is loaded already.
        try {
          const { replaySessionTail } = await import("../ui/replay.js");
          replaySessionTail(store, id);
        } catch {}
        log(chalk.green(`  Loaded session ${id} (${userMsgs} messages${factsInfo})`));
      } catch {
        log(chalk.red(`  Session "${id}" not found.`));
      }
    },

    // Owner, 2026-10-02: "does it have something like /resume?" It had
    // /sessions and /load <id>, which means reading ids off a list and typing
    // one back. /resume picks from the recent sessions with the arrows, newest
    // first, each with the last thing asked in it.
    async "/resume"(arg) {
      const id = (arg || "").trim();
      if (id) return commands["/load"](id);
      const current = store.getState().sessionId;
      const sessions = (await listSessions())
        .filter((x) => x.id !== current && x.userMessages > 0)
        .slice(0, 30);
      if (!sessions.length) {
        log(chalk.gray("  No other sessions to resume."));
        return;
      }
      const items = sessions.map((x) => ({
        id: x.id,
        when: x.updated ? new Date(x.updated) : null,
        count: x.userMessages,
        last: String(x.last || "").replace(/\s+/g, " ").trim(),
      }));
      store.getState().openOverlay("session", "Resume a session", items);
    },

    async "/new"() {
      const killed = store.getState().killAllRunning();
      if (killed > 0) log(chalk.gray(` killed ${killed} background process${killed > 1 ? "es" : ""}`));
      const { flush, abortAll } = await import("../bus/drain-loop.js");
      // Abort any in-flight API messages BEFORE clearing the screen,
      // otherwise their tokens keep streaming and render on top of the fresh banner.
      const aborted = abortAll();
      if (aborted > 0) {
        // Give abort handlers one tick to flush their final error lines.
        await new Promise(r => setTimeout(r, 50));
      }
      flush(); // clear bus queue
      // Run-level flow state (interrupt, retry caps) no longer resets per turn.
      const { resetFlow } = await import("../agent/flow-controller.js");
      resetFlow();
      const oldId = store.getState().sessionId;
      const oldMessages = store.getState().messages || [];

      // Extract session-end memory BEFORE we reset. Both reflections (L1) and
      // facts (L4) must persist so the NEXT session's system prompt includes them.
      // Fire-and-forget used to race the session reset — next session built its
      // prompt before extraction finished. Fix: await with a hard timeout cap
      // (6s) so /new cannot hang forever if LLM call stalls.
      if (oldId && oldMessages.length > 2) {
        const timeoutMs = 6000;
        const withTimeout = (p) => Promise.race([
          p,
          new Promise(resolve => setTimeout(() => resolve(null), timeoutMs)),
        ]);
        const { extractAndStoreReflection } = await import("../agent/reflection-extractor.js");
        const { extractFacts } = await import("../memory/extract-facts.js");
        const { addFact } = await import("../memory/facts.js");
        const { getCurrentProject } = await import("../memory/project.js");
        const currentProject = getCurrentProject();
        await Promise.allSettled([
          withTimeout(extractAndStoreReflection(oldMessages, oldId).catch(() => {})),
          withTimeout((async () => {
            try {
              const facts = await extractFacts(oldMessages);
              if (Array.isArray(facts)) {
                for (const f of facts) {
                  // Route to project scope: project/tech/env/decision → scoped;
                  // preference/person/general about user → global.
                  const scopedCats = new Set(["project", "tech", "env", "decision", "bug"]);
                  const projectScope = scopedCats.has(f.category) ? currentProject : null;
                  try { addFact(f.content, f.category || "general", "user", 0.8, projectScope); } catch {}
                }
              }
            } catch {}
          })()),
        ]);
      }

      const newId = generateSessionId();
      store.getState().resetSession(newId, [getSystemMessage()]);
      store.getState().clearDatasets();
      abandonAllActiveGoals();
      if (oldId) clearSessionFacts(oldId);
      clearDigest(newId);
      store.getState().clearScreen();
      log(chalk.cyan(` Flint v${store.getState()._version || "?"}`));
      log(chalk.gray(` model:   ${config.model} (${config.provider})`));
      log(chalk.gray(` session: ${newId} (new)`));
      log("");
    },

    async "/queue"() {
      const msgs = bus.pending();
      const s = bus.stats();
      if (!msgs.length && s.processing === 0) {
        log(chalk.gray("  No queued messages."));
        return;
      }
      log("");
      log(chalk.cyan(`  Bus queue: ${s.pending} pending, ${s.processing} processing`));
      for (const msg of msgs) {
        const preview = msg.content.length > 60 ? msg.content.slice(0, 60) + "..." : msg.content;
        log(`  ${chalk.yellow(`#${msg.id}`)} ${chalk.gray(`[${msg.channel}]`)} ${chalk.white(preview)}`);
      }
      log("");
    },

    async "/queue clear"() {
      const { flush } = await import("../bus/drain-loop.js");
      flush();
      log(chalk.gray("  Bus queue flushed."));
    },

    // Programs paired with the HTTP API, which is the only way in by default.
    async "/paired"(arg) {
      const { listPairedClients, revokePairedClients } = await import("../security/pairing.js");
      const m = (arg || "").trim().match(/^revoke\s+(.+)$/);
      if (m) {
        const n = revokePairedClients(m[1].trim());
        log(chalk.gray(n ? `  Revoked ${n} pairing(s): ${m[1].trim()}` : `  No pairing named ${m[1].trim()}.`));
        return;
      }
      const list = listPairedClients();
      if (!list.length) {
        log(chalk.gray("  No paired programs. A program asks with POST /pair/request; the PIN shows here."));
        return;
      }
      log("");
      log(chalk.cyan(`  Paired programs: ${list.length}`));
      for (const c of list) {
        const until = c.expiresAt ? `, expires ${c.expiresAt.slice(0, 16).replace("T", " ")} UTC` : ", does not expire";
        log(`  ${chalk.white(c.name)} ${chalk.gray(`from ${c.address}, paired ${c.pairedAt.slice(0, 16).replace("T", " ")}${until}`)}`);
      }
      log(chalk.gray("  /paired revoke <name> or /paired revoke all"));
      log("");
    },

    async "/later"(arg) {
      const text = (arg || "").trim();
      if (!text) {
        log(chalk.red("  Usage: /later <question or task>"));
        return;
      }
      const { id } = bus.push({ channel: "user", content: text, priority: bus.PRIORITY.USER, source: "later" });
      log(chalk.gray(`  queued (bus #${id}): ${text.length > 60 ? text.slice(0, 60) + "..." : text}`));
      busPush(); // notify drain loop
    },

    async "/clear"() {
      const s = store.getState();
      s.resetSession(s.sessionId, [getSystemMessage()]);
      s.clearDatasets();
      clearSessionFacts(s.sessionId);
      clearDigest(s.sessionId);

      // Re-read provider state from disk (provider.json may have changed)
      const { getActiveProvider, getLastModel } = await import("../providers/state.js");
      const { getProvider, reloadProviders } = await import("../providers/registry.js");
      reloadProviders();
      const freshProvider = getActiveProvider();
      const providerDef = getProvider(freshProvider);
      if (providerDef) {
        config.provider = freshProvider;
        const lastModel = getLastModel(freshProvider);
        config.model = lastModel || providerDef.defaultModel;
        s.setModel(config.model);
        s.setProvider(freshProvider);
        await config.resolveApiKey();
        const { fetchModelInfo } = await import("../api/client.js");
        const info = await fetchModelInfo(config.model);
        if (info) s.setPricing(info);
      }

      s.clearScreen();
      log(chalk.cyan(` Flint v${s._version || "?"}`));
      log(chalk.gray(` model:   ${config.model} (${config.provider})`));
      log(chalk.gray(` session: ${s.sessionId} (cleared)`));
      log("");
      await saveSession(s.sessionId, {
        messages: [getSystemMessage()],
        model: config.model,
        inputHistory: s.inputHistory,
      });
    },

    // Install a newer Flint, then restart in the same session
    // (docs/self-update.md). Refuses when it would overwrite local work.
    async "/update"() {
      const { runUpdate, installKind } = await import("../update.js");
      const { restartKeepingSession } = await import("../restart.js");
      const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
      const root = config.projectRoot;
      const s = store.getState();
      log("");
      await runUpdate({
        root,
        kind: installKind(root),
        current: pkg.version,
        log: (l) => log(chalk.gray(`  ${l}`)),
        restart: async () => {
          await saveSession(s.sessionId, {
            messages: s.messages, model: config.model, profile: s._profile, inputHistory: s.inputHistory,
            lastSummary: s.lastSummary, pastedImages: s.pastedImages, provider: config.provider,
            sessionCost: s.sessionCost, sessionPromptTokens: s.sessionPromptTokens, sessionCompletionTokens: s.sessionCompletionTokens,
          });
          restartKeepingSession(s.sessionId, 300);
        },
      });
      log("");
    },

    async "/restart"() {
      const s = store.getState();
      // Do NOT persist `plan` or pendingAction on /restart — those are
      // in-flight execution state. Carrying them through exit code 42
      // into the fresh process caused an "autonomous loop sticky across
      // restart" bug (observed 2026-04-21): a plan-style probe entered
      // autonomous mode, /restart was used to stop it, and the new
      // process picked up the saved plan and immediately resumed the
      // same loop. Conversation history + profile + input history are
      // fine to preserve (they're idempotent, no active state). Plan
      // stays cleared on restart — user can /continue or /plan to
      // resume explicitly.
      await saveSession(s.sessionId, {
        messages: s.messages,
        model: config.model,
        profile: s._profile,
        inputHistory: s.inputHistory,
        lastSummary: s.lastSummary,
        pastedImages: s.pastedImages,
        // The restart continues this session now, cost included.
        provider: config.provider,
        sessionCost: s.sessionCost,
        sessionPromptTokens: s.sessionPromptTokens,
        sessionCompletionTokens: s.sessionCompletionTokens,
      });
      log(chalk.yellow("\n  Restarting agent, same session...\n"));
      const { restartKeepingSession } = await import("../restart.js");
      restartKeepingSession(s.sessionId, 100);
    },

    async "/stats"() {
      const s = store.getState();
      const userMsgs = s.messages.filter((m) => m.role === "user").length;
      const totalMsgs = s.messages.length;
      const totalTokens = s.sessionPromptTokens + s.sessionCompletionTokens;
      log("");
      log(chalk.gray(`  session:  ${s.sessionId}`));
      log(chalk.gray(`  model:    ${config.model}`));
      log(chalk.gray(`  provider: ${config.provider}`));
      log(chalk.gray(`  profile:  ${s._profile || "?"}`));
      log(chalk.gray(`  messages: ${totalMsgs} total, ${userMsgs} from user`));
      log(chalk.gray(`  tokens:   ${totalTokens} (^${s.sessionPromptTokens} v${s.sessionCompletionTokens})`));
      log(chalk.gray(`  spent:    $${s.sessionCost.toFixed(6)}`));
      log(chalk.gray(`  api:      ${apiUrl(s._port || config.port)}`));
      log("");
    },

    async "/budget"() {
      const s = store.getState();
      const spent = s.sessionCost || 0;
      const budget = config.sessionBudget;
      const perAction = config.maxCostPerAction;
      log("");
      log(chalk.white("  Session Budget"));
      log(chalk.gray(`  spent:       $${spent.toFixed(6)}`));
      if (budget > 0) {
        const pct = (spent / budget * 100).toFixed(1);
        const remaining = Math.max(0, budget - spent);
        const color = pct > 80 ? chalk.red : pct > 50 ? chalk.yellow : chalk.green;
        log(chalk.gray(`  budget:      $${budget.toFixed(2)}`));
        log(color(`  remaining:   $${remaining.toFixed(6)} (${pct}% used)`));
      } else {
        log(chalk.gray("  budget:      unlimited (set AGENT_SESSION_BUDGET)"));
      }
      if (perAction > 0) {
        log(chalk.gray(`  per-action:  $${perAction.toFixed(2)} max`));
      }
      const totalTokens = (s.sessionPromptTokens || 0) + (s.sessionCompletionTokens || 0);
      log(chalk.gray(`  tokens:      ${totalTokens} (^${s.sessionPromptTokens || 0} v${s.sessionCompletionTokens || 0})`));
      log("");
    },

    async "/model"(arg) {
      const modelId = (arg || "").trim();
      // Model check (docs/model-check.md): six small agent tasks on a model,
      // in the background. /model test [free | <id> ...]
      if (/^test(\s|$)/i.test(modelId)) {
        const rest = modelId.slice(4).trim();
        const mc = await import("../model-check.js");
        let models = rest ? rest.split(/\s+/) : [config.model];
        if (/^free$/i.test(rest)) {
          const fm = await import("../free-models.js");
          const found = await fm.loadFreeModels();
          if (found.limit <= 50) {
            log(chalk.yellow("  Your OpenRouter account is on the free tier (50 free requests a day), and a check takes about 15 requests a model. Check one at a time: /model test <id>."));
            return;
          }
          models = found.models.map((m) => m.id);
        }
        log(chalk.gray(`  Checking ${models.length} model${models.length === 1 ? "" : "s"} in the background, six tasks each (about 15 requests a model).`));
        mc.startCheckRun(models, (l) => log(chalk.cyan(`  check: ${l}`)));
        return;
      }
      // Free mode (docs/free-mode.md): the free models with their speed, the
      // best one with two fallbacks. "/model free auto" takes it without a list.
      if (/^free(\s+auto)?$/i.test(modelId)) {
        const fm = await import("../free-models.js");
        log(chalk.gray("  Looking up OpenRouter's free models and their speed..."));
        let found;
        try {
          found = await fm.loadFreeModels();
        } catch (err) {
          log(chalk.red(`  Could not list the free models: ${err.message}`));
          return;
        }
        if (!found.models.length) {
          log(chalk.yellow("  No free model with tool calling is listed right now."));
          return;
        }
        if (/auto$/i.test(modelId)) {
          await fm.applyFreeChain({ chain: fm.freeChain(found.models), limit: found.limit, store, log: (l) => log(chalk.green(`  ${l}`)) });
          return;
        }
        const items = found.models.map((m) => ({ ...m, chain: fm.freeChain(found.models, m.id), limit: found.limit }));
        store.getState().openOverlay("free", `Free models · OpenRouter · last 30 min · your limit: ${found.limit} requests/day`, items);
        return;
      }
      if (modelId) {
        // Any other model leaves free mode.
        if (config.freeChain) {
          const { clearFreeChain } = await import("../free-models.js");
          await clearFreeChain();
        }
        // Switch model
        const { fetchModelInfo } = await import("../api/client.js");
        const prev = config.model;
        config.model = modelId;
        store.getState().setModel(modelId);
        // Remembered per provider, as the pick list already did; without this
        // "/model <id>" was forgotten on the next start (owner, 2026-10-01).
        try {
          const { setLastModel } = await import("../providers/state.js");
          setLastModel(config.provider, modelId);
        } catch {}
        try {
          const info = await fetchModelInfo(modelId);
          if (info) store.getState().setPricing(info);
        } catch {}
        log("");
        log(chalk.green(`  Switched: ${prev} → ${modelId}`));
        log("");
        return;
      }
      const s = store.getState();
      log("");
      log(chalk.cyan(`  Model: ${config.model}`));
      log(chalk.gray(`  Provider: ${config.provider}`));
      if (s.pricing) {
        log(chalk.gray(`  Price: $${(s.pricing.prompt * 1e6).toFixed(2)} / $${(s.pricing.completion * 1e6).toFixed(2)} per 1M tokens (in/out)`));
      }
      if (s.contextLimit) {
        log(chalk.gray(`  Context: ${(s.contextLimit / 1000).toFixed(0)}k tokens`));
      }
      log(chalk.gray('  Usage: /model <model-id> to switch, e.g. /model google/gemini-2.5-flash'));
      log("");
    },

    async "/project"(arg) {
      const { getCurrentProject, setCurrentProject, clearCurrentProject } = await import("../memory/project.js");
      const parts = (arg || "").trim().split(/\s+/);
      const sub = parts[0]?.toLowerCase();
      if (!sub || sub === "show") {
        const current = getCurrentProject();
        if (current) log(chalk.cyan(`  Current project: ${current}`));
        else log(chalk.gray("  No project scope (global only)."));
        log(chalk.gray("  Usage: /project [show | set <name> | clear]"));
        return;
      }
      if (sub === "set") {
        const name = parts[1];
        if (!name) { log(chalk.red("  Usage: /project set <name>")); return; }
        setCurrentProject(name);
        log(chalk.green(`  Project scope set to: ${name.toLowerCase()}`));
        return;
      }
      if (sub === "clear") {
        clearCurrentProject();
        const current = getCurrentProject();
        log(chalk.green(`  Project override cleared. Auto-detected: ${current || "(none)"}`));
        return;
      }
      log(chalk.red(`  Unknown subcommand: ${sub}. Use show | set <name> | clear`));
    },

    async "/provider"(arg) {
      const { listProviders, getProvider } = await import("../providers/registry.js");
      const { hasKey } = await import("../providers/keys.js");
      const { setActiveProvider, getLastModel } = await import("../providers/state.js");

      const name = (arg || "").trim().toLowerCase();
      if (name) {
        // Switch to provider
        const provider = getProvider(name);
        if (!provider) {
          log(chalk.red(`  Unknown provider: ${name}`));
          return;
        }
        if (provider.keyRequired && !hasKey(name)) {
          log(chalk.red(`  No API key for ${provider.name}. Use /key ${name} to add one.`));
          return;
        }
        config.provider = name;
        setActiveProvider(name);
        const lastModel = getLastModel(name);
        config.model = lastModel || provider.defaultModel;
        store.getState().setModel(config.model);
        store.getState().setProvider(name);
        await config.resolveApiKey();

        // Fetch pricing
        const { fetchModelInfo } = await import("../api/client.js");
        const info = await fetchModelInfo(config.model);
        if (info) store.getState().setPricing(info);

        log(chalk.green(`  Switched to ${provider.name} (${config.model})`));
      } else {
        // Open interactive provider menu
        const providers = listProviders();
        const items = providers.map((p) => {
          const keyInfo = p.keyRequired
            ? (hasKey(p.id) ? "yes" : "no")
            : "local";
          return {
            id: p.id,
            name: p.name,
            info: keyInfo,
            current: p.id === config.provider,
            disabled: p.keyRequired && !hasKey(p.id),
          };
        });
        store.getState().openOverlay("provider", "Select Provider", items);
      }
    },

    async "/key"(arg) {
      const { hasKey, setKey, deleteKey, listConfiguredProviders } = await import("../providers/keys.js");
      const { getProvider } = await import("../providers/registry.js");

      const parts = (arg || "").trim().split(/\s+/);
      const providerId = parts[0]?.toLowerCase();
      const action = parts[1]?.toLowerCase();

      if (!providerId) {
        // Show which providers have keys
        const configured = listConfiguredProviders();
        log("");
        log(chalk.cyan("  API Keys:"));
        if (configured.length === 0) {
          log(chalk.gray("  No keys configured."));
        } else {
          for (const id of configured) {
            const p = getProvider(id);
            log(`  ${chalk.green("+")} ${chalk.white(id)} ${chalk.gray(p?.name || "")}`);
          }
        }
        log(chalk.gray("\n  /key <provider>        -- set API key"));
        log(chalk.gray("  /key <provider> delete -- remove API key"));
        log("");
        return;
      }

      const provider = getProvider(providerId);
      if (!provider) {
        log(chalk.red(`  Unknown provider: ${providerId}`));
        return;
      }

      if (action === "delete") {
        await deleteKey(providerId);
        log(chalk.green(`  Key deleted for ${provider.name}.`));
        return;
      }

      // Prompt for key input (read from stdin)
      log(chalk.cyan(`  Enter API key for ${provider.name}:`));
      log(chalk.gray("  (paste key and press Enter)"));

      // The key is read through the app's own input box in secret mode, NOT
      // through a second readline on stdin. Owner, 2026-10-01: readline and
      // the Ink input both received the pasted line; readline saved the key
      // and the Ink input submitted it as a chat message, so the key was sent
      // to the model and written to the session log. Secret mode masks the
      // text and hands it only to this resolver (see App.js).
      const key = await new Promise((resolve) => {
        store.setState({ secretPrompt: { label: `${provider.name} API key`, resolve } });
      });
      const trimmed = String(key || "").trim();
      if (!trimmed) {
        log(chalk.gray("  Cancelled."));
        return;
      }
      await setKey(providerId, trimmed);
      log(chalk.green(`  Key saved for ${provider.name} (encrypted).`));

      // If this is the current provider, refresh the cached key
      if (providerId === config.provider) {
        await config.resolveApiKey();
      }
    },

    // The onboarding menu promised "you can change it later with /careful",
    // and there was no such command (owner, 2026-10-01).
    async "/careful"(arg) {
      const { getOnboardingAnswer, saveOnboardingAnswer } = await import("../tools/permissions.js");
      const { levelOptions, parseLevelAnswer, DEFAULT_ONBOARDING_LEVEL } = await import("../security/policies.js");
      const current = getOnboardingAnswer() || DEFAULT_ONBOARDING_LEVEL;
      const wanted = (arg || "").trim();
      if (!wanted) {
        log("");
        for (const o of levelOptions()) {
          const mark = o.level === current ? chalk.green("  > ") : "    ";
          log(`${mark}${chalk.white(o.level.padEnd(11))}${chalk.gray(o.description)}`);
        }
        log(chalk.gray("  /careful safe | normal | permissive   (or s, n, p)"));
        log("");
        return;
      }
      const level = parseLevelAnswer(wanted);
      if (!level) {
        log(chalk.red(`  Unknown level: ${wanted}. Use safe, normal or permissive.`));
        return;
      }
      saveOnboardingAnswer(level);
      store.setState({ _careLevel: level }); // redraw the status line
      log(chalk.green(`  care: ${level}`));
    },

    // How many tokens go into each call: economy, normal, generous
    // (docs/spend-modes.md). The next model call uses the new level.
    async "/spend"(arg) {
      const { getSpendLevel, setSpendLevel, parseSpendName, SPEND_NAMES, SPEND_LEVELS } = await import("../spend.js");
      const current = getSpendLevel();
      const wanted = (arg || "").trim();
      if (!wanted) {
        log("");
        for (const name of SPEND_NAMES) {
          const mark = name === current ? chalk.green("  > ") : "    ";
          log(`${mark}${chalk.white(name.padEnd(10))}${chalk.gray(SPEND_LEVELS[name].description)}`);
        }
        if (process.env.FLINT_SPEND) log(chalk.yellow(`  FLINT_SPEND=${process.env.FLINT_SPEND} is set and wins over /spend.`));
        log(chalk.gray("  /spend economy | normal | generous   (or e, n, g)"));
        log("");
        return;
      }
      if (!parseSpendName(wanted)) {
        log(chalk.red(`  Unknown level: ${wanted}. Use economy, normal or generous.`));
        return;
      }
      const level = setSpendLevel(wanted);
      store.setState({ _spendLevel: level }); // redraw the footer
      log(chalk.green(`  spend: ${level}`));
    },

    // The former Processes / Tool Log / System tabs, as commands that print a
    // snapshot into history once (docs/console-spec.md).
    async "/ps"() {
      const procs = store.getState().processes || [];
      if (!procs.length) {
        log(chalk.gray("  No background processes."));
        return;
      }
      log("");
      for (const p of [...procs].reverse()) {
        const exit = p.exitCode != null ? ` (exit ${p.exitCode})` : "";
        const color = p.status === "running" ? chalk.yellow : p.status === "done" ? chalk.green : chalk.red;
        log(`  [bg ${p.id}] ${color(p.status.padEnd(7))} ${p.command || p.cmd}${chalk.gray(exit)}`);
      }
      log(chalk.gray("  /logs <id> for output, /kill <id> or /kill all to stop."));
      log("");
    },

    async "/logs"(arg) {
      const id = parseInt((arg || "").trim(), 10);
      const p = (store.getState().processes || []).find((x) => x.id === id);
      if (!p) {
        log(chalk.red("  Usage: /logs <id>   (ids are in /ps)"));
        return;
      }
      log("");
      log(chalk.cyan(`  [bg ${p.id}] ${p.command || p.cmd}  ${p.status}`));
      if (!p.output.length) log(chalk.gray("    (no output)"));
      for (const line of p.output) log(`    ${line}`);
      log("");
    },

    async "/kill"(arg) {
      const a = (arg || "").trim().toLowerCase();
      if (a === "all") {
        const n = store.getState().killAllRunning();
        log(chalk.yellow(`  Stopped ${n} background process${n === 1 ? "" : "es"}.`));
        return;
      }
      const id = parseInt(a, 10);
      if (!id) {
        log(chalk.red("  Usage: /kill <id> or /kill all   (ids are in /ps)"));
        return;
      }
      const ok = store.getState().killProcess(id);
      log(ok ? chalk.yellow(`  Stopped bg ${id}.`) : chalk.gray(`  bg ${id} is not running.`));
    },

    async "/tools"(arg) {
      const n = parseInt((arg || "").trim(), 10) || 20;
      const acts = (store.getState().toolActivities || []).filter((a) => a.name && a.name !== "---").slice(-n);
      if (!acts.length) {
        log(chalk.gray("  No tool calls yet."));
        return;
      }
      log("");
      for (const a of acts) {
        const outcome = a.status === "running" ? "running" : a.result === "DENIED" ? "denied" : String(a.result || "done");
        const args = String(a.args || "").replace(/\s+/g, " ").slice(0, 60);
        log(`  ${chalk.white(a.name)} ${chalk.gray(args)} ${chalk.gray("->")} ${outcome.replace(/\s+/g, " ").slice(0, 60)}`);
      }
      log("");
    },

    async "/sys"() {
      const [{ renderToString }, React, { SystemPanel }] = await Promise.all([
        import("ink"), import("react"), import("../components/SystemPanel.js"),
      ]);
      const text = renderToString(React.createElement(SystemPanel, { store }), { columns: process.stdout.columns || 80 });
      log("");
      for (const line of text.split("\n")) log(line);
      log("");
    },

    async "/plan"() {
      const plan = syncPlanToStore(store);
      if (!plan) {
        log(chalk.gray("  No active plan."));
      } else {
        log("");
        log(chalk.cyan(`  Plan #${plan.goalId}: ${plan.goal} (${plan.project})`));
        for (const t of plan.tasks) {
          let icon, color;
          if (t.status === "done") { icon = "+"; color = chalk.green; }
          else if (t.status === "in_progress") { icon = ">"; color = chalk.yellow; }
          else if (t.status === "skipped") { icon = "-"; color = chalk.gray; }
          else { icon = "o"; color = chalk.white; }
          let line = `  [${t.id}] ${icon} ${t.title}`;
          if (t.result) line += chalk.gray(` - ${t.result}`);
          log(color(line));
        }
        log("");
      }
    },

    async "/tasks"(arg) {
      const filter = (arg || "").trim();
      if (filter === "all") {
        const goals = listGoals();
        if (!goals.length) {
          log(chalk.gray("  No goals in database."));
          return;
        }
        log("");
        for (const g of goals) {
          const stats = getTaskStats(g.id);
          const statusColor = g.status === "active" ? chalk.green : g.status === "completed" ? chalk.gray : chalk.red;
          log(`  ${statusColor(`[${g.status}]`)} #${chalk.yellow(g.id)} ${chalk.white(g.title)} ${chalk.gray(`(${g.project})`)} ${chalk.gray(`${stats.done}/${stats.total} done`)}`);
        }
        log(chalk.gray("\n  /tasks        -- active goals with task details"));
        log(chalk.gray("  /tasks all    -- all goals (active + completed + abandoned)"));
        log("");
        return;
      }

      const dashboard = getDashboard();
      if (!dashboard.length) {
        log(chalk.gray("  No active tasks. Use /auto or ask AI to create_plan."));
        return;
      }
      log("");
      for (const g of dashboard) {
        log(chalk.cyan(`  Goal #${g.id}: ${g.title} (${g.project})`));
        log(chalk.gray(`  Created: ${g.created_at}  |  ${g.stats.done}/${g.stats.total} done, ${g.stats.pending} pending`));
        for (const t of g.tasks) {
          let icon, color;
          if (t.status === "done") { icon = "+"; color = chalk.green; }
          else if (t.status === "in_progress") { icon = ">"; color = chalk.yellow; }
          else if (t.status === "skipped") { icon = "-"; color = chalk.gray; }
          else { icon = "o"; color = chalk.white; }
          let line = `    [${t.id}] ${icon} ${t.title}`;
          if (t.result) line += chalk.gray(` - ${t.result}`);
          log(color(line));
        }
        log("");
      }
    },

    async "/rewind"(arg) {
      const param = (arg || "").trim().toLowerCase();
      const stack = getCheckpointStack();

      if (!stack.length) {
        log(chalk.gray("  No changes to rewind."));
        return;
      }

      if (param === "all") {
        const restored = await rewindAll();
        log("");
        log(chalk.cyan(`  Rewound ${restored.length} change(s):`));
        for (const r of restored) {
          log(chalk.green(`    ${r.action}: ${r.path}`));
        }
        log("");
        return;
      }

      // Show stack if no arg, or rewind N
      const count = parseInt(param) || 1;

      if (!param) {
        // Show what can be rewound
        log("");
        log(chalk.cyan(`  Checkpoint stack: ${stack.length} change(s)`));
        const show = stack.slice(-10).reverse();
        for (const s of show) {
          const age = Math.round((Date.now() - s.timestamp) / 1000);
          const label = s.existed ? s.type : "create";
          log(chalk.gray(`    [${label}] ${s.path} (${age}s ago)`));
        }
        if (stack.length > 10) log(chalk.gray(`    ... and ${stack.length - 10} more`));
        log(chalk.gray("\n  /rewind     -- undo last change"));
        log(chalk.gray("  /rewind N   -- undo last N changes"));
        log(chalk.gray("  /rewind all -- undo everything"));
        log("");
        return;
      }

      const restored = await rewind(count);
      log("");
      log(chalk.cyan(`  Rewound ${restored.length} change(s):`));
      for (const r of restored) {
        log(chalk.green(`    ${r.action}: ${r.path}`));
      }
      log("");
    },

    async "/profile"(arg) {
      const profileName = (arg || "").trim();
      if (profileName) {
        try {
          const profile = loadProfile(profileName);
          store.setState({ _profile: profileName });
          store.getState().setProfile(profileName);
          // Switch agent-memory workspace to match profile
          try {
            const { execFileSync } = await import("node:child_process");
            const bin = process.env.AGENT_MEMORY_BIN || "agent-memory";
            execFileSync(bin, ["focus", profileName], { timeout: 3000, stdio: "ignore" });
            // Prefetch new workspace context
            const { prefetchAgentMemory } = await import("../agent/system-prompt.js");
            await prefetchAgentMemory();
            log(chalk.gray(`  agent-memory workspace: ${profileName}`));
          } catch {}
          // Rebuild system message with profile + agent-memory context
          const { getSystemMessage } = await import("../agent/system-prompt.js");
          const app = (await import("../app-state.js")).app;
          app.activeProfile = profileName;
          app.profileConfig = profile;
          const sysMsg = { role: "system", content: getSystemMessage(store.getState().sessionId, { profile: profileName, profileContent: profile.content, datasets: store.getState().datasets }) };
          app.systemMessage = sysMsg;
          const s = store.getState();
          s.resetSession(s.sessionId, [sysMsg]);
          log(chalk.green(`  Switched to profile: ${profileName}`));
          log("");
        } catch (err) {
          log(chalk.red(`  ${err.message}`));
        }
      } else {
        const profiles = listProfileNames();
        const current = store.getState()._profile || "desktop";
        log("");
        log(chalk.cyan("  Profiles:"));
        for (const p of profiles) {
          const marker = p === current ? chalk.green(" (current)") : "";
          try {
            const cfg = loadProfile(p);
            log(`  ${chalk.white(p)}${marker} ${chalk.gray("-- " + cfg.description)}`);
          } catch {
            log(`  ${chalk.white(p)}${marker}`);
          }
        }
        log(chalk.gray("\n  Usage: /profile <name>"));
        log("");
      }
    },

    async "/agents"() {
      log(chalk.gray("  Scanning..."));
      const agents = await listAgents({ checkAlive: true });
      if (!agents.length) {
        log(chalk.gray("  No running agents found."));
      } else {
        log("");
        for (const a of agents) {
          const isSelf = a.pid === process.pid;
          const tag = isSelf ? chalk.green(" (this)") : "";
          log(
            `  :${chalk.yellow(a.port)}  ${chalk.gray(a.model || "?")}  ${a.profile || "?"}  ${a.sessionId || "?"}${tag}`,
          );
        }
      }
      log("");
    },

    async "/mcp"() {
      const servers = getMcpServerStatus();
      if (!servers.length) {
        log(chalk.gray("  No MCP servers configured."));
        log("");
        return;
      }
      log("");
      log(chalk.cyan("  MCP Servers:"));
      for (const s of servers) {
        const status = s.connected ? chalk.green("[+]") : chalk.red("[ ]");
        log(`  ${status} ${chalk.white(s.name)}  ${chalk.gray(s.url)}`);
      }
      log(chalk.gray("\n  Reconnect/disconnect via the agent or MCP_SERVERS env var."));
      log("");
    },

    async "/memory"() {
      const stats = getMemoryStats();
      log("");
      log(chalk.cyan(`  Memory: ${stats.total} entries`));
      if (stats.total > 0) {
        for (const [cat, count] of Object.entries(stats.byCategory)) {
          log(chalk.gray(`    ${cat}: ${count}`));
        }
        const recent = listRecentMemories(3);
        log(chalk.gray("  Recent:"));
        for (const m of recent) {
          log(chalk.gray(`    [#${m.id}] ${m.content.slice(0, 60)}`));
        }
      }
      log("");
    },

    async "/memory clear"() {
      clearAllMemories();
      updateMemoryMd();
      log(chalk.green("  All memories cleared."));
    },

    async "/permissions"() {
      const map = getPermissionMap();
      const groups = { allow: [], confirm: [], deny: [] };
      for (const [name, level] of Object.entries(map)) {
        (groups[level] || (groups[level] = [])).push(name);
      }
      log("");
      log(chalk.cyan("  Permissions:"));
      if (groups.allow.length) {
        log(chalk.green("  allow:   ") + chalk.gray(groups.allow.join(", ")));
      }
      if (groups.confirm.length) {
        log(chalk.yellow("  confirm: ") + chalk.gray(groups.confirm.join(", ")));
      }
      if (groups.deny.length) {
        log(chalk.red("  deny:    ") + chalk.gray(groups.deny.join(", ")));
      }
      log("");
      log(chalk.gray("  /allow|deny|confirm <tool>  /allow-all  /deny-all  /reset-permissions"));
      log("");
    },

    async "/allow"(arg) {
      const tool = (arg || "").trim();
      if (!tool) { log(chalk.red("  Usage: /allow <tool>")); return; }
      setPermission(tool, "allow");
      log(chalk.green(`  ${tool} -> allow`));
    },

    async "/deny"(arg) {
      const tool = (arg || "").trim();
      if (!tool) { log(chalk.red("  Usage: /deny <tool>")); return; }
      setPermission(tool, "deny");
      log(chalk.red(`  ${tool} -> deny`));
    },

    async "/confirm"(arg) {
      const tool = (arg || "").trim();
      if (!tool) { log(chalk.red("  Usage: /confirm <tool>")); return; }
      setPermission(tool, "confirm");
      log(chalk.yellow(`  ${tool} -> confirm`));
    },

    async "/allow-all"() {
      bulkSetPermission("allow");
      log(chalk.green("  All tools -> allow (no confirmations)"));
    },

    async "/deny-all"() {
      bulkSetPermission("deny");
      log(chalk.red("  All tools -> deny (nothing executes)"));
    },

    async "/reset-permissions"() {
      resetSessionOverrides();
      log(chalk.cyan("  Permissions reset to defaults"));
    },

    async "/auto"(task) {
      const { app } = await import("../app-state.js");
      if (!task) {
        // Toggle or show status
        if (app.autonomous) {
          app.autonomous = false;
          log(chalk.yellow("  Autonomous mode: OFF (interactive)"));
        } else {
          log(chalk.gray("  Autonomous mode is OFF. Use: /auto <task> to start autonomous work."));
        }
        return;
      }
      // Start autonomous mode: create plan via message, enable self-continue
      app.autonomous = true;
      bulkSetPermission("allow"); // autonomous needs tool access
      log(chalk.green("  Autonomous mode: ON"));
      log(chalk.gray(`  Task: ${task}`));
      log(chalk.gray("  Tools: auto-approved. Use /auto to stop."));
      // Push the task as a message
      const busMod = await import("../bus/index.js");
      const { notify, resetAutonomous } = await import("../bus/drain-loop.js");
      resetAutonomous();
      busMod.push({
        channel: "user",
        content: `Work autonomously on this task. Create a plan with create_plan, break into subtasks, and complete everything. When all tasks are done, report results.\n\nTask: ${task}`,
        priority: busMod.PRIORITY?.USER || 1,
        source: "auto",
      });
      notify();
    },

    async "/plugins"() {
      const loaded = getLoadedPlugins();
      const installed = listInstalledPlugins();
      log("");
      if (!installed.length) {
        log(chalk.gray("  No plugins installed."));
        log(chalk.gray(`  Directory: ${getPluginsDir()}`));
        log(chalk.gray("  Install:   /install <name-or-path>"));
      } else {
        log(chalk.cyan("  Plugins:"));
        for (const name of installed) {
          const info = loaded.find((p) => p.name === name);
          if (info) {
            log(`  ${chalk.green("[+]")} ${chalk.white(name)} ${chalk.gray(`v${info.version}`)} ${chalk.gray(`(${info.toolCount} tools, ${info.type})`)}`);
          } else {
            log(`  ${chalk.red("[ ]")} ${chalk.white(name)} ${chalk.gray("(not loaded)")}`);
          }
        }
        log(chalk.gray(`\n  Directory: ${getPluginsDir()}`));
      }
      log("");
    },

    async "/install"(arg) {
      const target = (arg || "").trim();
      if (!target) {
        log(chalk.red("  Usage: /install <plugin-name-or-path>"));
        return;
      }
      log(chalk.yellow("  WARNING: Plugins run with full system access (filesystem, commands, network)."));
      log(chalk.yellow("  Only install plugins from trusted sources."));
      log(chalk.gray(`  Installing ${target}...`));
      const result = await installPlugin(target);
      if (result.ok) {
        // Loaded now, the way install_plugin does it for the agent.
        const r = await activatePlugin(result.path);
        if (r.error) {
          log(chalk.red(`  Installed ${result.name}, but it did not load: ${r.error}`));
        } else {
          log(chalk.green(`  Installed and loaded: ${result.name}`) + chalk.gray(r.tools.length ? ` (${r.tools.join(", ")})` : ""));
        }
      } else {
        log(chalk.red(`  Error: ${result.error}`));
      }
    },

    async "/uninstall"(arg) {
      const target = (arg || "").trim();
      if (!target) {
        log(chalk.red("  Usage: /uninstall <plugin-name>"));
        return;
      }
      const result = uninstallPlugin(target);
      if (result.ok) {
        const old = unregisterPlugin(pathJoin(getPluginsDir(), result.name));
        if (old?.destroy) { try { await old.destroy(); } catch {} }
        log(chalk.green(`  Removed: ${result.name}`));
      } else {
        log(chalk.red(`  Error: ${result.error}`));
      }
    },

    // -- Dataset navigation --

    async "/next"() {
      const entries = Object.values(store.getState().datasets);
      if (!entries.length) { log(chalk.gray("  No active datasets.")); return; }
      const ds = entries[entries.length - 1];
      const totalPages = Math.ceil(ds.rows.length / ds.pageSize);
      const next = Math.min(ds.page + 1, totalPages);
      store.getState().setDatasetPage(ds.id, next);
      const start = (next - 1) * ds.pageSize;
      printTable(ds.columns, ds.rows.slice(start, start + ds.pageSize),
        `${ds.label} (page ${next}/${totalPages}, ${ds.rows.length} total)`,
        `Page ${next}/${totalPages} | /next /prev /page ${ds.label} N`);
    },

    async "/prev"() {
      const entries = Object.values(store.getState().datasets);
      if (!entries.length) { log(chalk.gray("  No active datasets.")); return; }
      const ds = entries[entries.length - 1];
      const totalPages = Math.ceil(ds.rows.length / ds.pageSize);
      const prev = Math.max(ds.page - 1, 1);
      store.getState().setDatasetPage(ds.id, prev);
      const start = (prev - 1) * ds.pageSize;
      printTable(ds.columns, ds.rows.slice(start, start + ds.pageSize),
        `${ds.label} (page ${prev}/${totalPages}, ${ds.rows.length} total)`,
        `Page ${prev}/${totalPages} | /next /prev /page ${ds.label} N`);
    },

    async "/page"(arg) {
      const parts = (arg || "").trim().split(/\s+/);
      const datasets = store.getState().datasets;
      const entries = Object.values(datasets);
      if (!entries.length) { log(chalk.gray("  No active datasets.")); return; }

      let ds, pageNum;
      if (parts.length === 1 && /^\d+$/.test(parts[0])) {
        // /page 3 — last dataset
        ds = entries[entries.length - 1];
        pageNum = parseInt(parts[0], 10);
      } else if (parts.length >= 2) {
        // /page emails 3 — find by label or id
        const name = parts[0];
        ds = entries.find((d) => d.label === name || d.id === name);
        pageNum = parseInt(parts[1], 10);
      }

      if (!ds) { log(chalk.red(`  Dataset not found. Available: ${entries.map(d => d.label).join(", ")}`)); return; }
      if (!pageNum || isNaN(pageNum)) { log(chalk.red("  Usage: /page [name] <number>")); return; }

      const totalPages = Math.ceil(ds.rows.length / ds.pageSize);
      const clamped = Math.max(1, Math.min(pageNum, totalPages));
      store.getState().setDatasetPage(ds.id, clamped);
      const start = (clamped - 1) * ds.pageSize;
      printTable(ds.columns, ds.rows.slice(start, start + ds.pageSize),
        `${ds.label} (page ${clamped}/${totalPages}, ${ds.rows.length} total)`,
        `Page ${clamped}/${totalPages} | /next /prev /page ${ds.label} N`);
    },
    async "/copy"() {
      const lines = s.lines || [];
      // Strip ANSI codes and join
      const ansiRe = /\x1b\[[0-9;]*m/g;
      const text = lines
        .map((l) => (l.text || "").replace(ansiRe, ""))
        .filter((t) => t.trim())
        .join("\n");

      if (!text) {
        log(chalk.gray("  Nothing to copy."));
        return;
      }

      try {
        const { execSync } = await import("node:child_process");
        if (process.platform === "win32") {
          execSync("clip", { input: text, timeout: 3000 });
        } else if (process.platform === "darwin") {
          execSync("pbcopy", { input: text, timeout: 3000 });
        } else {
          execSync("xclip -selection clipboard", { input: text, timeout: 3000 });
        }
        log(chalk.green(`  Copied ${lines.length} lines to clipboard.`));
      } catch (err) {
        log(chalk.red(`  Failed to copy: ${err.message}`));
      }
    },
  };

  return commands;
}
