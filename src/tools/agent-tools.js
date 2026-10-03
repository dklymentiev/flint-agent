import { spawn } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import os from "node:os";
import { config } from "../config.js";
import { createLogger } from "../logging/logger.js";
import {
  printChildAgent, printChildSpawn, printChildEvent,
} from "../ui/output.js";
import { activeChildren } from "./process-tools.js";
import { getTask, getTasksByGoalAndStatus, getTaskStats } from "../tasks/queries.js";
import { apiUrl } from "../api/address.js";

const log = createLogger("agents");

// ── Child agent registry ──
const _childAgents = new Map(); // port → { procId, pid, task, port, status, missedPings }
let _nextChildPort = 3010;
const HEARTBEAT_INTERVAL = 15000; // 15s
const MAX_MISSED_PINGS = 3;
let _heartbeatTimer = null;

// Keep the pid a child reports in /status: for an agent in its own window it
// is the only handle on the real process (the launcher's pid is dead).
async function notePid(agent, res) {
  if (!agent.visible || agent.agentPid || typeof res.json !== "function") return;
  try {
    const data = await res.json();
    if (Number.isInteger(data?.pid)) agent.agentPid = data.pid;
  } catch {}
}

// Start heartbeat monitoring for child agents
function startChildHeartbeat(store) {
  if (_heartbeatTimer) return;
  _heartbeatTimer = setInterval(async () => {
    for (const [port, agent] of _childAgents) {
      if (agent.status !== "running" && agent.status !== "starting") continue;
      try {
        const res = await fetch(apiUrl(port, "/status"), {
          signal: AbortSignal.timeout(3000),
        });
        if (res.ok) {
          await notePid(agent, res);
          if (agent.missedPings > 0) {
            // Recovered
            const label = agent.profile !== "generic" ? agent.profile : null;
            printChildEvent(port, "connection restored", label);
          }
          agent.missedPings = 0;
          continue;
        }
      } catch {}
      // Ping failed
      agent.missedPings = (agent.missedPings || 0) + 1;
      const label = agent.profile !== "generic" ? agent.profile : null;
      if (agent.missedPings >= MAX_MISSED_PINGS) {
        agent.status = "lost";
        log.warn(`Agent@${port} connection lost after ${MAX_MISSED_PINGS} missed pings`);
        printChildEvent(port, `connection lost (${MAX_MISSED_PINGS} missed pings)`, label);
        store.getState().finishProcess(agent.procId, null, "lost");
        activeChildren.delete(agent.procId);
        // A visible agent has no "close" of its own to clean up after it
        // (spawn_agent), so the heartbeat does it.
        if (agent.visible) {
          if (agent.taskRegId) store.getState().unregisterTask(agent.taskRegId);
          setTimeout(() => _childAgents.delete(port), config.childCleanupDelay);
        }
      } else {
        log.debug(`Agent@${port} no response (${agent.missedPings}/${MAX_MISSED_PINGS})`);
        printChildEvent(port, `no response (${agent.missedPings}/${MAX_MISSED_PINGS})`, label);
      }
    }
    // Stop heartbeat if no active children
    const hasActive = [..._childAgents.values()].some((a) => a.status === "running" || a.status === "starting");
    if (!hasActive && _heartbeatTimer) {
      clearInterval(_heartbeatTimer);
      _heartbeatTimer = null;
    }
  }, HEARTBEAT_INTERVAL);
}

// ── Tool definitions ──

export const agentToolDefs = [
  {
    type: "function",
    function: {
      name: "spawn_agent",
      description: "Spawn a new agent instance in a separate process and give it a task. The child agent runs on its own port and has full tool access. Use for parallel work: testing, refactoring, research, etc.",
      parameters: {
        type: "object",
        properties: {
          task: { type: "string", description: "The task/message to send to the new agent" },
          task_id: { type: "integer", description: "SQLite task ID to assign to the child agent. Child will claim it, update status, and report result. Use with create_plan for coordinated parallel work." },
          port: { type: "integer", description: "Port for the child agent (default: auto-assign from 3010+)" },
          profile: { type: "string", description: "Profile for child agent (default: generic). Options: desktop, generic, marketer" },
          model: { type: "string", description: "Model for child agent (default: same as parent)" },
          visible: { type: "boolean", description: "Open agent in a new visible console window (default: false, runs headless)" },
        },
        required: ["task"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ask_agent",
      description: "Send a message to a running child agent and get its response. Use the port from spawn_agent result.",
      parameters: {
        type: "object",
        properties: {
          port: { type: "integer", description: "Port of the child agent" },
          message: { type: "string", description: "Message to send" },
        },
        required: ["port", "message"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_agents",
      description: "List all spawned child agents with their status, port, and task.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "wait_tasks",
      description: "Wait for all tasks in a goal to complete (done/skipped). Use after spawning child agents with task_id to block until they finish. Returns task results summary.",
      parameters: {
        type: "object",
        properties: {
          goal_id: { type: "integer", description: "Goal ID to monitor (from create_plan result)" },
          timeout: { type: "integer", description: "Max wait time in seconds (default: 300)" },
        },
        required: ["goal_id"],
      },
    },
  },
];

/**
 * Where a child agent on `port` keeps its data: under the parent's data
 * folder, one folder per port, so no two Flint processes share a queue.
 */
export function childDataDir(port, parentDir = process.env.FLINT_DATA_DIR || path.join(os.homedir(), ".flint")) {
  return path.join(parentDir, "children", String(port));
}

// ── Handler implementations ──

export function createAgentHandlers(store) {
  return {
    async spawn_agent({ task, task_id, port, profile, model, visible }) {
      // Enforce max child agents limit
      const runningChildren = [..._childAgents.values()].filter((a) => a.status === "starting" || a.status === "running").length;
      if (runningChildren >= config.maxChildAgents) {
        return `Error: max child agents limit reached (${config.maxChildAgents}). Use list_agents() to see running agents, or kill some first.`;
      }

      const assignedPort = port || (_nextChildPort++);
      const childProfile = profile || "generic";
      const isWin = process.platform === "win32";

      let cmd = `node src/index.js --new --port ${assignedPort} --profile ${childProfile}`;
      if (model) cmd += ` --model ${model}`;

      // Inherit sandbox + filter API keys for child agents
      const { getDeniedPaths } = await import("./filesystem.js");
      const denied = getDeniedPaths();
      const pairingSecret = crypto.randomBytes(32).toString("hex");
      const childEnv = { ...process.env, AGENT_PORT: String(assignedPort) };
      // Filter all known API key env vars — child gets key only via provider-specific var
      delete childEnv.OPENAI_API_KEY;
      delete childEnv.ANTHROPIC_API_KEY;
      delete childEnv.OPENROUTER_API_KEY;
      // Pass active provider to child agent
      childEnv.FLINT_PROVIDER = config.provider;
      if (config.apiKey) {
        // Pass current provider's key via the appropriate env var
        if (config.provider === "openrouter") childEnv.OPENROUTER_API_KEY = config.apiKey;
        else if (config.provider === "openai") childEnv.OPENAI_API_KEY = config.apiKey;
        else if (config.provider === "anthropic") childEnv.ANTHROPIC_API_KEY = config.apiKey;
        else childEnv.OPENROUTER_API_KEY = config.apiKey; // generic fallback
      }
      // The child's own data folder: its message queue, sessions and memory.
      // Without it parent and child shared one tasks.db queue: either could
      // take the other's messages, and a child's start-up recover() put the
      // parent's own long-running message back in the queue for anyone to run
      // again (found 2026-10-02, before a spawn for a research task).
      childEnv.FLINT_DATA_DIR = childDataDir(assignedPort);
      // Pairing secret for parent↔child auth
      childEnv.AGENT_PAIRING_SECRET = pairingSecret;
      // Parent port for orphan protection heartbeat
      childEnv.AGENT_PARENT_PORT = String(config.port);
      // Idle exit, off by default (0): a child lives as long as its parent,
      // and the parent heartbeat in index.js stops it when the parent is
      // gone, which is what the idle exit was first added for. A 60 s default
      // stopped children between two questions, so a conversation with one
      // was impossible (owner, 2026-10-02). AGENT_CHILD_IDLE_TIMEOUT turns it on.
      childEnv.AGENT_IDLE_TIMEOUT = String(config.childIdleTimeout || 0);
      // Track agent depth for child-policy enforcement
      const currentDepth = parseInt(process.env.AGENT_DEPTH || "0", 10);
      childEnv.AGENT_DEPTH = String(currentDepth + 1);
      // Task-driven child agent: pass task_id so child can claim and update it
      if (task_id) {
        childEnv.AGENT_TASK_ID = String(task_id);
      }
      if (denied.length) {
        childEnv.AGENT_DENIED_PATHS = denied.join(",");
      }

      // Ensure display server vars survive for visible GUI terminals
      if (visible && !isWin) {
        for (const v of ["DISPLAY", "XAUTHORITY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR"]) {
          if (process.env[v] && !childEnv[v]) childEnv[v] = process.env[v];
        }
      }

      let child;
      if (visible && isWin) {
        // A temp .bat opened in a new window with `start`, so the child has a
        // console of its own. The environment (API key, pairing secret) goes
        // to cmd.exe, and `start` hands it to the new window. It used to be
        // written into the .bat as `set` lines, which left the API key in
        // plain text in %TEMP% for good, while Flint stores keys encrypted
        // everywhere else (found 2026-10-02).
        const os = await import("node:os");
        const fs = await import("node:fs");
        const batPath = path.join(os.tmpdir(), `flint-agent-${assignedPort}.bat`);
        const batLines = [
          "@echo off",
          `title Flint@${assignedPort}`,
          `cd /d "${config.projectRoot}"`,
          cmd,
        ];
        fs.writeFileSync(batPath, batLines.join("\r\n") + "\r\n");

        child = spawn("cmd.exe", ["/c", "start", `"Flint@${assignedPort}"`, batPath], {
          env: childEnv,
          stdio: "ignore",
          detached: true,
          windowsHide: true,
        });
        child.unref();
      } else if (visible && !isWin) {
        // Unix: try tmux/screen (headless servers), then GUI terminals
        const strategies = [
          // tmux — best for servers, creates named session
          ["tmux", ["new-session", "-d", "-s", `flint-${assignedPort}`, "-x", "120", "-y", "40", `cd ${config.projectRoot} && ${cmd}`]],
          // screen — fallback for servers without tmux
          ["screen", ["-dmS", `flint-${assignedPort}`, "bash", "-c", `cd ${config.projectRoot} && ${cmd}`]],
          // GUI terminal emulators
          ["gnome-terminal", ["--", "bash", "-c", `cd ${config.projectRoot} && ${cmd}; exec bash`]],
          ["xterm", ["-e", `cd ${config.projectRoot} && ${cmd}`]],
        ];
        let spawned = false;
        for (const [term, args] of strategies) {
          try {
            child = spawn(term, args, {
              cwd: config.projectRoot,
              env: childEnv,
              stdio: "ignore",
              detached: true,
            });
            child.unref();
            spawned = true;
            printChildEvent(assignedPort, `visible via ${term}`, null);
            break;
          } catch {}
        }
        if (!spawned) {
          // Fallback to headless
          child = spawn("/bin/bash", ["-c", cmd], {
            cwd: config.projectRoot,
            env: childEnv,
            stdio: ["ignore", "pipe", "pipe"],
            detached: false,
          });
        }
      } else {
        // Headless mode (default)
        const shell = isWin ? "cmd.exe" : "/bin/bash";
        const shellArgs = isWin ? ["/c", cmd] : ["-c", cmd];
        child = spawn(shell, shellArgs, {
          cwd: config.projectRoot,
          env: childEnv,
          stdio: ["ignore", "pipe", "pipe"],
          detached: false,
        });
      }

      const procId = store.getState().addProcess({
        cmd: `agent@${assignedPort}`,
        pid: child.pid,
      });

      activeChildren.set(procId, child);
      _childAgents.set(assignedPort, { procId, pid: child.pid, task, port: assignedPort, status: "starting", profile: childProfile, token: pairingSecret, visible: !!visible, missedPings: 0 });

      // Register in TaskRegistry for Escape abort
      const taskRegId = store.getState().registerTask({
        type: "child-agent",
        label: `agent@${assignedPort}`,
        port: assignedPort,
        kill: () => {
          try {
            // A visible agent's own pid comes from its /status; child.pid is
            // the window launcher, long gone.
            const agentPid = _childAgents.get(assignedPort)?.agentPid;
            if (visible && agentPid) {
              if (process.platform === "win32") spawn("taskkill", ["/PID", String(agentPid), "/T", "/F"], { stdio: "ignore" });
              else process.kill(agentPid, "SIGTERM");
            } else if (process.platform === "win32" && child.pid) {
              spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
            } else {
              child.kill("SIGTERM");
            }
          } catch {}
        },
      });
      _childAgents.get(assignedPort).taskRegId = taskRegId;

      // Start heartbeat monitoring
      startChildHeartbeat(store);

      const childLabel = childProfile !== "generic" ? childProfile : null;
      printChildSpawn(assignedPort, child.pid, childLabel);

      // Only capture output for headless agents
      if (!visible) {
        const onData = (data) => {
          const lines = data.toString().split("\n");
          for (const line of lines) {
            if (line) store.getState().appendProcessOutput(procId, line);
          }
        };
        if (child.stdout) child.stdout.on("data", onData);
        if (child.stderr) child.stderr.on("data", onData);
      }

      child.on("close", (code) => {
        // A visible agent runs in a window that `start` (Windows), tmux,
        // screen or a terminal emulator opened; the process spawned here only
        // opens it and exits at once with 0. Taking that for the agent's exit
        // marked a live agent stopped and forgot it 5 s later, so ask_agent
        // answered "has stopped" and the model spawned a new agent for every
        // question (owner, 2026-10-02). The heartbeat decides when a visible
        // agent is gone; only a launcher that failed counts here.
        if (visible && code === 0) return;
        activeChildren.delete(procId);
        store.getState().unregisterTask(taskRegId);
        store.getState().finishProcess(procId, code);
        const agent = _childAgents.get(assignedPort);
        if (agent) agent.status = "stopped";
        printChildEvent(assignedPort, `exited (code ${code ?? "?"})`, childLabel);
        // Clean up zombie entry after delay so list_agents can still show exit info
        setTimeout(() => _childAgents.delete(assignedPort), config.childCleanupDelay);
      });

      child.on("error", (err) => {
        store.getState().appendProcessOutput(procId, `Error: ${err.message}`);
        store.getState().finishProcess(procId, 1, "failed");
        const agent = _childAgents.get(assignedPort);
        if (agent) agent.status = "error";
        setTimeout(() => _childAgents.delete(assignedPort), config.childCleanupDelay);
      });

      // Wait for agent to start, then send task
      const startTime = Date.now();
      const sendTask = async () => {
        for (let i = 0; i < 30; i++) {
          await new Promise((r) => setTimeout(r, 1000));
          try {
            const res = await fetch(apiUrl(assignedPort, "/status"), {
              signal: AbortSignal.timeout(2000),
            });
            if (res.ok) {
              const agent = _childAgents.get(assignedPort);
              if (agent) {
                agent.status = "running";
                await notePid(agent, res);
              }
              // Send the task (authenticated with pairing secret)
              const taskRes = await fetch(apiUrl(assignedPort, "/message"), {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "Authorization": `Bearer ${pairingSecret}`,
                },
                body: JSON.stringify({ content: task, name: "parent-agent" }),
                signal: AbortSignal.timeout(120000),
              });
              // Sent without waiting: the child works on it while the parent
              // goes on. This is the child taking the task, not answering it.
              await taskRes.json().catch(() => null);
              printChildEvent(assignedPort, `took its task (${((Date.now() - startTime) / 1000).toFixed(1)}s)`, childLabel);
              return;
            }
          } catch {}
        }
        printChildEvent(assignedPort, "failed to start within 30s", childLabel);
      };

      // Fire and forget — don't block the parent agent
      sendTask().catch(() => {});

      return `Agent spawned on port ${assignedPort} (pid ${child.pid}, process #${procId}).\nTask sent: "${task.slice(0, 100)}"\nUse ask_agent(port: ${assignedPort}, message: "...") to communicate.\nUse list_agents() to check status.`;
    },

    async ask_agent({ port, message }) {
      const agent = _childAgents.get(port);
      if (!agent) return `No agent on port ${port}. Use list_agents() to see available agents.`;
      if (agent.status === "stopped" || agent.status === "lost") return `Agent@${port} has stopped. Spawn a new one.`;

      // Wait for agent to be ready if it's still starting
      if (agent.status === "starting") {
        for (let i = 0; i < 30; i++) {
          await new Promise((r) => setTimeout(r, 1000));
          try {
            const check = await fetch(apiUrl(port, "/status"), { signal: AbortSignal.timeout(2000) });
            if (check.ok) { agent.status = "running"; await notePid(agent, check); break; }
          } catch {}
        }
        if (agent.status !== "running") return `Agent@${port} failed to start within 30s.`;
      }

      try {
        const headers = { "Content-Type": "application/json" };
        if (agent.token) headers["Authorization"] = `Bearer ${agent.token}`;
        const res = await fetch(apiUrl(port, "/message"), {
          method: "POST",
          headers,
          // sync: wait for the answer. Without it the child's API accepts the
          // message (202, a messageId) and returns, and every ask came back
          // "(no response)" though the child answered (2026-10-02). The
          // child's API waits up to 180 s, so this waits a little longer.
          body: JSON.stringify({ content: message, name: "parent-agent", sync: true }),
          signal: AbortSignal.timeout(190000),
        });
        if (!res.ok) return `Agent@${port} returned HTTP ${res.status}`;
        const data = await res.json();
        const response = data.response || "(no response)";
        const agentLabel = agent.profile && agent.profile !== "generic" ? agent.profile : null;
        printChildAgent(port, response, 20, agentLabel);
        return `Agent@${port} response:\n${response}`;
      } catch (err) {
        return `Error communicating with agent@${port}: ${err.message}`;
      }
    },

    async list_agents() {
      if (!_childAgents.size) return "No child agents spawned.";
      const lines = ["Port   | Profile  | Status   | PID   | Task"];
      for (const [port, agent] of _childAgents) {
        const taskShort = agent.task.length > 50 ? agent.task.slice(0, 50) + "..." : agent.task;
        const prof = (agent.profile || "generic").padEnd(8);
        lines.push(`${String(port).padEnd(6)} | ${prof} | ${agent.status.padEnd(8)} | ${String(agent.pid).padEnd(5)} | ${taskShort}`);
      }
      return lines.join("\n");
    },

    async wait_tasks({ goal_id, timeout }) {
      const maxWait = (timeout || 300) * 1000;
      const pollInterval = 3000; // 3s
      const start = Date.now();

      while (Date.now() - start < maxWait) {
        const stats = getTaskStats(goal_id);
        if (!stats || stats.total === 0) return `Error: no tasks found for goal #${goal_id}`;
        if (stats.pending === 0 && stats.in_progress === 0) {
          // All done/skipped — collect results
          const tasks = getTasksByGoalAndStatus(goal_id, ["done", "skipped"]);
          const lines = [`All ${stats.total} tasks completed for goal #${goal_id}:`];
          lines.push(`  Done: ${stats.done}, Skipped: ${stats.skipped}`);
          for (const t of tasks) {
            const icon = t.status === "done" ? "+" : "-";
            lines.push(`  [${icon}] #${t.id} ${t.title}${t.result ? ` — ${t.result}` : ""}`);
          }
          return lines.join("\n");
        }
        // Still in progress
        const elapsed = ((Date.now() - start) / 1000).toFixed(0);
        log.debug(`wait_tasks: goal #${goal_id} — ${stats.done}/${stats.total} done, ${stats.in_progress} in_progress (${elapsed}s)`);
        await new Promise((r) => setTimeout(r, pollInterval));
      }

      // Timeout — report partial results
      const stats = getTaskStats(goal_id);
      const remaining = getTasksByGoalAndStatus(goal_id, ["pending", "in_progress"]);
      const lines = [`Timeout (${timeout || 300}s) waiting for goal #${goal_id}:`];
      lines.push(`  Done: ${stats.done}, In progress: ${stats.in_progress}, Pending: ${stats.pending}`);
      for (const t of remaining) {
        lines.push(`  [>] #${t.id} ${t.title} (${t.status})`);
      }
      return lines.join("\n");
    },
  };
}
