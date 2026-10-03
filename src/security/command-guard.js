// Command guard — beforeHook that blocks dangerous shell commands

/**
 * Strip shell noise that is not going to be executed: content inside
 * single- and double-quoted strings, and shell comments (# to EOL).
 * This prevents false positives where `grep -n '| sh' file` is blocked
 * because the pattern argument contains `| sh`, or a script with
 * `# rm -f` in a comment is blocked because the comment contains `rm -f`.
 *
 * The result is only used for pattern matching — the original command
 * is what gets executed.
 *
 * Quoted text is dropped ONLY when it cannot run. It can run when the
 * command hands a string to something that executes it (`bash -c "..."`,
 * `eval "..."`, `ssh host "..."`, `xargs sh`, `python -c`...), and when a
 * double-quoted string holds `$(...)` or backticks. In those cases the
 * command is matched whole, as before. An earlier version dropped all quoted
 * text and let `bash -c "rm -rf /"` through.
 *
 * Pass the command BEFORE collapsing whitespace: a comment ends at a
 * newline, and the next line is a new command that must be matched.
 *
 * @param {string} cmd - Raw command string
 * @returns {string} Command with inert quoted content and comments stripped
 */
const RUNS_ITS_ARGUMENT = /(^|[\s;|&(`])(sh|bash|zsh|dash|ksh|fish|busybox|eval|exec|source|\.|xargs|parallel|ssh|su|sudo|doas|env|nohup|setsid|watch|timeout|nice|script|at|batch|crontab|python\d*(\.\d+)?|node|deno|bun|perl|ruby|php|lua|awk|gawk|sed|powershell|pwsh|cmd|cmd\.exe|wsl|-exec|-execdir)(?=$|[\s;|&)`<>])/;
// Outside quotes, `$` and backticks turn text into commands (`x='...'; $x`,
// `` `echo '...'` ``), and `>` writes it somewhere it may run later
// (`printf '...' > x.sh; ./x.sh`). Any of them: match the command whole.
const QUOTED_TEXT_MAY_RUN = /[`$>]/;
// A quoted path is an argument, not inert text: one word starting at a drive,
// a slash or ~ (`rm -rf "/"`, `del /s /q "C:\"`). Dropping it let quoting carry
// a hard-denied command through (2026-10-02). Text with spaces, such as a grep
// pattern, stays dropped.
const QUOTED_PATH = /^(?:[a-zA-Z]:|[\\/~])\S*$/;

export function stripShellNoise(cmd) {
  let result = "";
  let inSingle = false;
  let inDouble = false;
  let inComment = false;
  let quoted = "";

  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];

    // Inside a shell comment — skip until newline
    if (inComment) {
      if (ch === "\n") {
        result += "\n";
        inComment = false;
      }
      continue;
    }

    // Inside single quotes — no escapes, everything is literal
    if (inSingle) {
      if (ch === "'") {
        // A path is matched as if it were not quoted: drop the opening quote.
        if (QUOTED_PATH.test(quoted)) result = result.slice(0, -1) + quoted;
        else result += "'";
        inSingle = false;
        continue;
      }
      quoted += ch;
      continue;
    }

    // Inside double quotes — backslash escapes work. Command substitution
    // runs even inside double quotes, so such a string is kept.
    if (inDouble) {
      if (ch === "\\" && i + 1 < cmd.length) {
        quoted += ch + cmd[i + 1];
        i++; // skip escaped character
        continue;
      }
      if (ch === '"') {
        if (QUOTED_PATH.test(quoted)) {
          // A path is matched as if it were not quoted: drop the opening quote.
          result = result.slice(0, -1) + quoted;
          inDouble = false;
          continue;
        }
        if (/\$\(|`/.test(quoted)) result += quoted;
        result += '"';
        inDouble = false;
        continue;
      }
      quoted += ch;
      continue;
    }

    // Outside quotes and comments
    if (ch === "'") {
      result += "'";
      inSingle = true;
      quoted = "";
    } else if (ch === '"') {
      result += '"';
      inDouble = true;
      quoted = "";
    } else if (ch === "#") {
      // # starts a comment when it begins a word (preceded by space,
      // semicolon, pipe, ampersand, or start of string)
      if (i === 0 || /[\s;|&({]/.test(cmd[i - 1])) {
        inComment = true;
      } else {
        result += ch;
      }
    } else {
      result += ch;
    }
  }

  // An unclosed quote means we did not understand the command: match it whole.
  if (inSingle || inDouble) return cmd;
  // Something in the command executes a string: quoted text may run.
  if (RUNS_ITS_ARGUMENT.test(result) || QUOTED_TEXT_MAY_RUN.test(result)) return cmd;
  return result;
}

/**
 * Create a command-guard beforeHook.
 * @param {object} policy - Security policy from policies.js
 * @returns {Function} beforeHook(name, args)
 */
export function createCommandGuardHook(policy) {
  return function commandGuardHook(name, args) {
    if (name !== "run_command" && name !== "run_background_command") return null;

    const command = args.command;
    if (!command || typeof command !== "string") return null;

    // Strip inert quoted text and comments first, on the raw command, so a
    // newline still ends a comment; then normalize (collapse whitespace, trim).
    const stripped = stripShellNoise(command).replace(/\s+/g, " ").trim();

    // 1. Check hard deny patterns — these are always blocked
    for (const pattern of policy.commandDenyPatterns) {
      if (pattern.test(stripped)) {
        return {
          deny: true,
          reason: `dangerous command blocked: matches pattern ${pattern.source.slice(0, 40)}`,
          denyKey: `cmd:${pattern.source}`,
        };
      }
    }

    // 2. Check dangerous command patterns — force confirm even if permission is "allow"
    if (policy.dangerousCommandPatterns) {
      // An "[a]lways" the operator already gave for this command in THIS
      // project. Checked here, at the point of asking, so the grant applies to
      // every route to the same question — a tool set to "allow", a bulk
      // /allow-all, whatever the level is. A grant consulted only by the
      // permissions layer would not be consulted at all when the level was
      // permissive, and the answer the operator gave would depend on a setting
      // they did not think about.
      if (policy.readCommandApproval && policy.readCommandApproval({ cwd: args.cwd, command })) {
        return null;
      }
      for (const pattern of policy.dangerousCommandPatterns) {
        if (pattern.test(stripped)) {
          return {
            confirm: true,
            reason: `potentially destructive command: matches pattern ${pattern.source.slice(0, 40)}`,
          };
        }
      }
    }

    return null;
  };
}
