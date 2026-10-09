// What a host gives an agent at launch: its instructions (--system-prompt and
// friends, the CLAUDE.md chain) and the MCP servers of its folder (.mcp.json or
// --mcp-config). The stdio and the headless mode take both the same way, and
// both must end the same way when one of the files cannot be used: one line on
// stderr and exit code 2, the code for a launch that was asked for wrongly.
//
// One place, because the headless branch once read the same files with nothing
// around it: a wrong --system-prompt-file path or a .mcp.json with a typo came
// out of bootstrap() as an unhandled exception with a stack trace.

import { readFileSync } from "node:fs";
import { hostPromptFrom, mcpConfigPath } from "./stdio/session.js";
import { mcpJsonServers, parseServerConfig } from "./mcp-client.js";

/** Exit code of a launch whose flags or files cannot be used. */
export const LAUNCH_USAGE_EXIT = 2;

function readInstructions(file) {
  try {
    return readFileSync(file, "utf8");
  } catch (err) {
    throw new Error(`cannot read the instructions file ${file}: ${err.message}`);
  }
}

/**
 * The launch identity of `cli`, read from the current folder: the host prompt
 * ("" when there is none) and the server list, `mcpServers` (what MCP_SERVERS
 * already gave) with the file's servers after it. Throws an Error whose
 * message is the whole sentence for the operator, file named.
 */
export function readLaunchIdentity(cli, mcpServers) {
  const hostPrompt = hostPromptFrom(cli, { read: readInstructions });
  const mcpFile = mcpConfigPath(cli);
  if (!mcpFile) return { hostPrompt, mcpServers };
  let text;
  try {
    text = readFileSync(mcpFile, "utf8");
  } catch (err) {
    throw new Error(`cannot read the MCP config ${mcpFile}: ${err.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`the MCP config ${mcpFile} is not valid JSON: ${err.message}`);
  }
  return { hostPrompt, mcpServers: [...parseServerConfig(mcpServers), ...mcpJsonServers(parsed)] };
}

/**
 * readLaunchIdentity for a process start: a launch that cannot be read is said
 * in one line and the process ends with LAUNCH_USAGE_EXIT. `exit` and `stderr`
 * are injectable for tests.
 */
export function launchIdentityOrExit(cli, mcpServers, { exit = process.exit, stderr = process.stderr } = {}) {
  try {
    return readLaunchIdentity(cli, mcpServers);
  } catch (err) {
    stderr.write(`[flint] ${err.message}\n`);
    return exit(LAUNCH_USAGE_EXIT);
  }
}
