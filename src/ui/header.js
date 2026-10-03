import chalk from "chalk";
import { readFileSync } from "node:fs";
import { store } from "../store/index.js";
import { config } from "../config.js";
import { app } from "../app-state.js";
import { printSplash } from "./splash.js";
import { apiUrl } from "../api/address.js";

const _version = (() => { try { return JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf-8")).version; } catch { return "?"; } })();


// -- Formatting constants --
export const INDENT = " ";
export const ANSI_RE = /\x1b\[[0-9;]*m/g;

export function formatToolArgs(args) {
  if (!args || typeof args !== "object") return String(args || "");
  return Object.entries(args)
    .map(([k, v]) => {
      const val = typeof v === "string" ? v : JSON.stringify(v);
      return val.length > 60 ? `${k}="${val.slice(0, 60)}..."` : `${k}=${val}`;
    })
    .join(" ");
}

/**
 * Arguments for an approval prompt: nothing cut. formatToolArgs above cuts
 * every value at 60 characters, which is fine for a log line and wrong for a
 * question: the operator approved a command they could only partly see
 * (owner, 2026-10-01). A command comes first and bare; the rest as key=value.
 */
export function formatToolArgsFull(args) {
  if (!args || typeof args !== "object") return String(args || "");
  const parts = [];
  if (typeof args.command === "string") parts.push(args.command);
  for (const [k, v] of Object.entries(args)) {
    if (k === "command" && typeof v === "string") continue;
    parts.push(`${k}=${typeof v === "string" ? v : JSON.stringify(v)}`);
  }
  return parts.join("  ");
}

export function addIndented(indent, text) {
  store.getState().addLine(indent + text);
}

export function userMsgLine(text, sender, { trailingBlank = true } = {}) {
  const cols = process.stdout.columns || 80;
  const bg = chalk.bgHex("#333333").whiteBright;
  const maxWidth = cols - 2;
  const prefix = sender ? `${sender} > ` : "> ";
  const wrapPad = " ".repeat(prefix.length);

  function emitLine(content, indent) {
    const plain = content.replace(ANSI_RE, "");
    if (indent.length + plain.length <= maxWidth) {
      const pad = Math.max(0, maxWidth - indent.length - plain.length);
      store.getState().addLine(bg(` ${indent}${content}${" ".repeat(pad)} `));
    } else {
      // Word-wrap
      const wrapIndent = " ".repeat(indent.length);
      const words = content.split(" ");
      let line = "";
      let lineLen = 0;
      let first = true;
      for (const word of words) {
        const wordLen = word.replace(ANSI_RE, "").length;
        const limit = maxWidth - indent.length;
        if (lineLen > 0 && lineLen + 1 + wordLen > limit) {
          const pad = Math.max(0, maxWidth - indent.length - lineLen);
          store.getState().addLine(bg(` ${first ? indent : wrapIndent}${line}${" ".repeat(pad)} `));
          first = false;
          line = word;
          lineLen = wordLen;
        } else {
          line = lineLen > 0 ? line + " " + word : word;
          lineLen = lineLen > 0 ? lineLen + 1 + wordLen : wordLen;
        }
      }
      if (line) {
        const pad = Math.max(0, maxWidth - indent.length - lineLen);
        store.getState().addLine(bg(` ${first ? indent : wrapIndent}${line}${" ".repeat(pad)} `));
      }
    }
  }

  store.getState().addLine("");
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    emitLine(lines[i], i === 0 ? prefix : wrapPad);
  }
  // Without it, a note can sit right under the message ("✓ read").
  if (trailingBlank) store.getState().addLine("");
}

export function printHeader() {
  const s = store.getState();
  if (s.headerPrinted) return;
  s.clearScreen();
  // Mark header as printed AFTER clearScreen (which resets headerPrinted to false)
  store.setState({ headerPrinted: true });
  // Splash: the two-row FLiNT mark with vX.Y.Z (src/ui/splash.js)
  s.addLine("");
  s.addLine(printSplash(_version, true));
  s.addLine("");
  const modeLabel = app.profileConfig.contextMode === "window"
    ? `window(${app.profileConfig.windowSize})`
    : app.profileConfig.contextMode;
  s.addLine(chalk.gray(` model:   ${config.model}  |  provider: ${config.provider}  |  profile: ${app.activeProfile}  |  context: ${modeLabel}`));
  if (s.pricing) {
    let priceLine = ` price:   $${(s.pricing.prompt * 1e6).toFixed(2)} / $${(s.pricing.completion * 1e6).toFixed(2)} per 1M tokens (in/out)`;
    if (s.contextLimit) {
      priceLine += `  |  context: ${(s.contextLimit / 1000).toFixed(0)}k tokens`;
    }
    s.addLine(chalk.gray(priceLine));
  }
  s.addLine(chalk.gray(` session: ${s.sessionId}${s.messages.length > 1 ? ` (${s.messages.length - 1} msgs)` : " (new)"}`));
  s.addLine(chalk.gray(` api:     ${apiUrl(app.actualPort)}`));
  if (app.securityApi && app.securityApi.token) {
    s.addLine(chalk.gray(` token:   ${app.securityApi.token.slice(0, 8)}...  (${app.securityApi.policy?.name || "?"} policy)`));
  } else if (app.securityApi && !app.securityApi.disabled) {
    s.addLine(chalk.gray(` access:  programs pair with a PIN shown here; /paired lists them  (${app.securityApi.policy?.name || "?"} policy)`));
  }
  if (app.mcpStatusList.length) {
    for (const mc of app.mcpStatusList) {
      if (mc.connecting) {
        s.addLine(chalk.yellow(` mcp:     ${mc.name} -- connecting...`));
      } else if (mc.ok) {
        s.addLine(chalk.gray(` mcp:     ${mc.name} -- ${mc.tools} tools`));
      } else {
        s.addLine(chalk.yellow(` mcp:     ${mc.name} -- offline`));
      }
    }
  }
  // Ctrl+V is the terminal's own paste and sends nothing for a picture, so
  // the key that does is named where it will be seen (owner, 2026-10-02:
  // "I can't paste a picture").
  s.addLine(chalk.gray(' type /help for commands, "exit" to quit · Alt+V pastes a picture'));
  s.addLine("");
}
