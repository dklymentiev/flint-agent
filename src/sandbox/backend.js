// Sandbox backend — isolates shell command execution.
//
// Backends:
//   local  — current behavior, runs directly on host (default, dev mode)
//   docker — spawns per-session container, all commands inside
//
// Config: AGENT_SANDBOX env var (local|docker)
// Internal task reference removed.

import { spawn } from "node:child_process";
import { config } from "../config.js";
import os from "node:os";
import path from "node:path";

const SANDBOX_MODE = process.env.AGENT_SANDBOX || "local";
const DOCKER_IMAGE = process.env.AGENT_SANDBOX_IMAGE || "node:20-slim";

let _activeContainer = null;

/**
 * Get current sandbox mode.
 */
export function getSandboxMode() {
  return SANDBOX_MODE;
}

/**
 * Initialize sandbox for a session.
 * For docker: creates a container. For local: no-op.
 * @param {string} sessionId
 * @param {string} workdir — host directory to mount
 */
export async function initSandbox(sessionId, workdir) {
  if (SANDBOX_MODE !== "docker") return;

  const name = `flint-sandbox-${sessionId.replace(/[^a-zA-Z0-9-]/g, "").slice(0, 30)}`;

  // Create container with workdir mounted
  const args = [
    "create", "--name", name,
    "-w", "/workdir",
    "-v", `${workdir}:/workdir`,
    "--network", "none", // no outbound by default
    DOCKER_IMAGE,
    "sleep", "infinity",
  ];

  await runHost("docker", args, 30000);
  await runHost("docker", ["start", name], 10000);
  _activeContainer = name;
}

/**
 * Execute a command in the sandbox.
 * For docker: docker exec. For local: direct spawn.
 * @param {string} command — shell command
 * @param {string} cwd — working directory
 * @param {object} opts — { shell, env, timeout, signal }
 * @returns {Promise<{child, shell, shellArgs}>} — compatible with existing run_command flow
 */
export function wrapCommand(command, cwd, opts = {}) {
  if (SANDBOX_MODE === "docker" && _activeContainer) {
    // Route through docker exec
    const dockerArgs = [
      "exec", "-w", "/workdir",
      _activeContainer,
      "bash", "-c", command,
    ];
    return {
      shell: "docker",
      shellArgs: dockerArgs,
      cwd: undefined, // docker handles cwd internally
      env: opts.env || process.env,
    };
  }

  // Local mode — passthrough
  return {
    shell: opts.shell || config.shell,
    shellArgs: ["-c", command],
    cwd,
    env: opts.env,
  };
}

/**
 * Cleanup sandbox at session end.
 * For docker: removes the container.
 */
export async function cleanupSandbox() {
  if (SANDBOX_MODE !== "docker" || !_activeContainer) return;
  try {
    await runHost("docker", ["rm", "-f", _activeContainer], 15000);
  } catch {}
  _activeContainer = null;
}

/**
 * Check if Docker is available on host.
 */
export async function isDockerAvailable() {
  try {
    await runHost("docker", ["--version"], 5000);
    return true;
  } catch {
    return false;
  }
}

// Helper: run a command on HOST (not in sandbox)
function runHost(cmd, args, timeout = 30000) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${cmd} timeout after ${timeout}ms`));
    }, timeout);
    child.stdout.on("data", d => stdout += d);
    child.stderr.on("data", d => stderr += d);
    child.on("close", code => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`${cmd} exit ${code}: ${stderr.slice(0, 200)}`));
    });
  });
}

export const __internal = { SANDBOX_MODE, DOCKER_IMAGE };
