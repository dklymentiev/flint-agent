// Command-line flags of the stdio mode.
//
// Flint takes the flags agent CLIs commonly take for the same job, so a host that
// drives `claude` as a long-lived subprocess can start Flint with the same command line:
//
//   flint --print --verbose --model <id> \
//         --input-format stream-json --output-format stream-json \
//         [--session-id <id> | --resume <id>] [--dangerously-skip-permissions] \
//         [--system-prompt-file <path>] [--append-system-prompt <text>] \
//         [--mcp-config <path>]
//
// `--stdio` alone means the same thing. Flags such CLIs have and Flint does
// not need (--add-dir, --max-turns, ...) are accepted and ignored, so a host
// passing them does not have to know which agent it is talking to.

const VALUE_FLAGS = new Set([
  "--model", "--session-id", "--resume", "-r", "--system-prompt", "--system-prompt-file",
  "--append-system-prompt", "--append-system-prompt-file", "--mcp-config", "--input-format",
  "--output-format", "--cwd", "--max-turns", "--add-dir", "--permission-mode",
  "--allowedTools", "--allowed-tools", "--disallowedTools", "--disallowed-tools",
  "--fallback-model", "--settings", "--data-dir",
]);

/** Session ids become file names: letters, digits, dash and underscore only. */
export function isSafeSessionId(id) {
  return typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id);
}

/**
 * The stdio-mode options in argv, or null when Flint was not started in it.
 * Throws on a value that cannot be used, so the host sees the reason on
 * stderr and a non-zero exit instead of a session that quietly ignores it.
 */
export function parseStdioArgs(argv) {
  const args = argv.slice(2);
  const values = {};
  const flags = new Set();
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const eq = a.startsWith("--") ? a.indexOf("=") : -1;
    if (eq > 0) { values[a.slice(0, eq)] = a.slice(eq + 1); continue; }
    if (VALUE_FLAGS.has(a)) { values[a] = args[i + 1]; i++; continue; }
    flags.add(a);
  }
  const streaming = values["--input-format"] === "stream-json" || values["--output-format"] === "stream-json";
  if (!flags.has("--stdio") && !streaming) return null;
  if (values["--input-format"] && values["--input-format"] !== "stream-json") {
    throw new Error(`--input-format ${values["--input-format"]} is not supported; use stream-json`);
  }
  if (values["--output-format"] && values["--output-format"] !== "stream-json") {
    throw new Error(`--output-format ${values["--output-format"]} is not supported; use stream-json`);
  }
  const resume = values["--resume"] ?? values["-r"] ?? null;
  const sessionId = resume ?? values["--session-id"] ?? null;
  if (sessionId != null && !isSafeSessionId(sessionId)) {
    throw new Error(`session id "${sessionId}" may contain only letters, digits, - and _`);
  }
  return {
    model: values["--model"] || null,
    sessionId,
    resume: resume != null,
    systemPrompt: values["--system-prompt"] ?? null,
    systemPromptFile: values["--system-prompt-file"] ?? null,
    appendSystemPrompt: values["--append-system-prompt"] ?? null,
    appendSystemPromptFile: values["--append-system-prompt-file"] ?? null,
    mcpConfig: values["--mcp-config"] ?? null,
    cwd: values["--cwd"] ?? null,
    dataDir: values["--data-dir"] ?? null,
    skipPermissions: flags.has("--dangerously-skip-permissions") || values["--permission-mode"] === "bypassPermissions",
    verbose: flags.has("--verbose"),
  };
}
