// The stdio mode: Flint as a long-lived subprocess driven over stream-json,
// the way a host drives an agent CLI.
//
// One process is one session. Each `user` line on stdin is one turn; turns
// run one at a time, in order. While a turn runs, its model replies and tool
// results are written to stdout as they happen, and the turn ends with one
// `result` line. A `control_request` with subtype "interrupt" stops the
// running turn, which then ends with a `result` of subtype
// "error_during_execution". The process stays up
// between turns and exits when stdin closes, after the running turn.
//
// No terminal UI, no HTTP server, no message bus: a host that starts several
// of these gets several independent agents, not several readers of one queue.

import { createInterface } from "node:readline";
import { store } from "../store/index.js";
import { app } from "../app-state.js";
import { config } from "../config.js";
import { processMessage, setTurnObserver } from "../message-handler.js";
import { bulkSetPermission, setUnattended } from "../tools/permissions.js";
import { getDefinitions } from "../tools/registry.js";
import { killAllChildrenSync } from "../tools/process-tools.js";
import { saveSession } from "../sessions.js";
import { sessionData } from "../app-state.js";
import { initEvent } from "./protocol.js";
import { createStdioSession } from "./session.js";

const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g;

/** Run the stdio mode until stdin closes. Never returns. */
export async function runStdio({ opts, write, version }) {
  config.headless = true;
  if (opts.model) {
    config.model = opts.model;
    store.getState().setModel(opts.model);
  }
  if (opts.skipPermissions) bulkSetPermission("allow");

  // Every store line goes to stderr: the host keeps it for diagnosis
  // (gateway: the stderr tail in the session's error record).
  const addLine = store.getState().addLine.bind(store.getState());
  store.setState({
    addLine: (text, ...rest) => {
      const raw = typeof text === "string" ? text.replace(ANSI_RE, "") : String(text ?? "");
      if (raw.trim()) process.stderr.write(raw.replace(/\s+$/, "") + "\n");
      return addLine(text, ...rest);
    },
  });

  // The MCP servers connect in the background; the first turn waits for
  // them (up to 15 s, as the bus does for API messages), or the agent would
  // start without the tools its host gave it.
  const waitStart = Date.now();
  while (!app.mcpReady && Date.now() - waitStart < 15000) await new Promise((r) => setTimeout(r, 200));

  const sessionId = store.getState().sessionId;
  write(initEvent({
    sessionId,
    model: config.model,
    cwd: process.cwd(),
    tools: getDefinitions().map((t) => t.function?.name).filter(Boolean),
    mcpServers: (app.mcpStatusList || []).map((s) => ({ name: s.name, status: s.ok ? "connected" : "failed" })),
    permissionMode: opts.skipPermissions ? "bypassPermissions" : "default",
    version,
  }));

  const session = createStdioSession({
    write,
    sessionId,
    model: () => config.model,
    run: async (content, { signal, observer }) => {
      // Nobody can answer an approval prompt here: a tool that would ask is
      // refused at once (permissions.js, unattended), unless the host passed
      // --dangerously-skip-permissions.
      setUnattended(true);
      setTurnObserver(observer);
      try {
        return await processMessage(content, null, { signal });
      } finally {
        setTurnObserver(null);
      }
    },
    // What an agent CLI leaves in the transcript after a stop. Without it the
    // next turn read the stopped command as unfinished work and ran it again,
    // in the background this time (2026-10-02).
    onInterrupted: async () => {
      store.getState().pushMessage({ role: "user", content: "[Request interrupted by user. Do not resume that work unless asked again.]" });
      await saveSession(sessionId, sessionData(store));
    },
    onIdleEnd: () => shutdown(0),
  });

  // Background processes the agent started end with it: a host that closes
  // stdin or kills this process expects nothing of it left behind.
  function shutdown(code) {
    try { killAllChildrenSync(); } catch {}
    process.exit(code);
  }
  process.on("SIGTERM", () => shutdown(143));
  process.on("SIGINT", () => shutdown(130));

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", (l) => session.line(l));
  rl.on("close", () => session.end());
  await new Promise(() => {});
}
