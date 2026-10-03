// Command registry -- tries to handle /commands, returns true if handled

import { registerCommands } from "./commands.js";

let commands = null;

export function initCommands(store) {
  commands = registerCommands(store);
}

// Whether input is meant as a /command rather than a message to the agent.
// A leading "/" alone is not enough: "/work/match.mp4 is 12 seconds long..."
// is a task that starts with an absolute path, and treating it as a command
// answered "Unknown command" and never ran it. Over the API that reply has no
// messageId, so a caller polled for fifteen minutes in a benchmark run.
// Every command name is a slash and a word; a path has a second slash or a dot.
export function isSlashCommand(input) {
  const first = String(input).trim().split(/\s/)[0];
  return /^\/[a-z][a-z0-9_-]*$/i.test(first);
}

export async function tryHandleCommand(input, store) {
  if (!commands) return false;

  const trimmed = input.trim();
  const lower = trimmed.toLowerCase();

  // Direct match commands (no arguments) — includes /budget, /stats, etc.
  if (commands[lower]) {
    await commands[lower]();
    return true;
  }

  // Commands with arguments
  if (lower.startsWith("/load ")) {
    const arg = trimmed.slice(6);
    await commands["/load"](arg);
    return true;
  }
  if (lower.startsWith("/profile ")) {
    const arg = trimmed.slice(9);
    await commands["/profile"](arg);
    return true;
  }
  if (lower.startsWith("/allow ")) {
    await commands["/allow"](trimmed.slice(7));
    return true;
  }
  if (lower.startsWith("/deny ")) {
    await commands["/deny"](trimmed.slice(6));
    return true;
  }
  if (lower.startsWith("/confirm ")) {
    await commands["/confirm"](trimmed.slice(9));
    return true;
  }
  if (lower === "/memory clear") {
    await commands["/memory clear"]();
    return true;
  }
  if (lower === "/queue clear") {
    await commands["/queue clear"]();
    return true;
  }
  if (lower.startsWith("/later ")) {
    await commands["/later"](trimmed.slice(7));
    return true;
  }
  if (lower.startsWith("/tasks ")) {
    await commands["/tasks"](trimmed.slice(7));
    return true;
  }
  if (lower.startsWith("/rewind ")) {
    await commands["/rewind"](trimmed.slice(8));
    return true;
  }
  if (lower.startsWith("/model ")) {
    await commands["/model"](trimmed.slice(7));
    return true;
  }
  if (lower.startsWith("/provider ")) {
    await commands["/provider"](trimmed.slice(10));
    return true;
  }
  if (lower === "/provider") {
    await commands["/provider"]();
    return true;
  }
  if (lower.startsWith("/key ")) {
    await commands["/key"](trimmed.slice(5));
    return true;
  }
  if (lower === "/key") {
    await commands["/key"]();
    return true;
  }
  if (lower.startsWith("/install ")) {
    await commands["/install"](trimmed.slice(9));
    return true;
  }
  if (lower.startsWith("/uninstall ")) {
    await commands["/uninstall"](trimmed.slice(11));
    return true;
  }
  if (lower.startsWith("/page ")) {
    await commands["/page"](trimmed.slice(6));
    return true;
  }
  if (lower.startsWith("/auto ")) {
    await commands["/auto"](trimmed.slice(6));
    return true;
  }
  if (lower === "/auto") {
    await commands["/auto"]();
    return true;
  }

  // Any other known command with an argument: "/kill 3", "/logs 3",
  // "/tools 10", "/careful permissive". Only the prefixes listed above used to
  // get their argument, so a command added later answered "Unknown command"
  // as soon as it was given one (owner, 2026-10-01).
  const space = trimmed.search(/\s/);
  if (space > 0) {
    const name = lower.slice(0, space);
    if (typeof commands[name] === "function") {
      await commands[name](trimmed.slice(space + 1).trim());
      return true;
    }
  }

  return false;
}
