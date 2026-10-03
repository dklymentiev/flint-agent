import http from "node:http";
import { createPairingSession, verifyPin } from "../security/pairing.js";
import { createLogger } from "../logging/logger.js";
import { app } from "../app-state.js";
import { API_HOST } from "./address.js";

const log = createLogger("server");

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
  });
}

// Server reads from store + uses processMessage callback for messages
export function startServer(port, store, processMessage, opts = {}) {
  log.info(`Starting server, requested port: ${port}`);
  const { getAbortController, onStop, getPlan, onCommand, authMiddleware, onPairingRequest, onPairingResult, strictPort } = opts;

  const server = http.createServer(async (req, res) => {
    // Dynamic CORS: allow localhost with any port
    const origin = req.headers.origin || "";
    const isLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
    res.setHeader("Access-Control-Allow-Origin", isLocalhost ? origin : "http://localhost");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // Auth check (after CORS headers are set)
    if (authMiddleware) {
      const authorized = authMiddleware(req, res);
      if (!authorized) return; // response already sent by middleware
    }

    const url = new URL(req.url, `http://localhost:${port}`);
    const json = (code, data) => {
      res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(data));
    };

    function parseJson(raw) {
      try { return JSON.parse(raw); }
      catch { return null; }
    }

    try {
      // POST /pair/request -- initiate pairing
      if (url.pathname === "/pair/request" && req.method === "POST") {
        const body = await readBody(req);
        const parsed = body ? JSON.parse(body) : {};
        const fromAddress = req.socket.remoteAddress || "unknown";
        const agentName = parsed.agentName || parsed.name || null;
        const result = createPairingSession(fromAddress);
        if (result.error) {
          json(429, { error: result.error });
          return;
        }
        if (onPairingRequest) {
          onPairingRequest({
            sessionId: result.sessionId,
            pin: result.pin,
            fromAddress,
            agentName,
            expiresAt: result.expiresAt,
          });
        }
        json(200, { sessionId: result.sessionId, expiresAt: result.expiresAt });
        return;
      }

      // POST /pair/confirm -- verify PIN and get token
      if (url.pathname === "/pair/confirm" && req.method === "POST") {
        const body = parseJson(await readBody(req));
        if (!body) { json(400, { error: "invalid JSON" }); return; }
        if (!body.sessionId || !body.pin) {
          json(400, { error: "sessionId and pin are required" });
          return;
        }
        const fromAddress = req.socket.remoteAddress || "unknown";
        // Get agent name from the pending pairing state
        const pendingPairing = store.getState().pendingPairing;
        const agentName = pendingPairing?.agentName || null;
        const result = verifyPin(body.sessionId, body.pin, { name: agentName, address: fromAddress });
        if (!result.valid) {
          if (onPairingResult) onPairingResult({ success: false, fromAddress, agentName, error: result.error });
          json(403, { error: result.error });
          return;
        }
        if (onPairingResult) onPairingResult({ success: true, fromAddress, agentName });
        json(200, { token: result.token });
        return;
      }

      // POST /message -- send a message to the agent
      // Modes:
      //   ?sync=true  — wait for result (old behavior, 180s timeout)
      //   default     — async: return messageId immediately, poll GET /message/:id
      if (url.pathname === "/message" && req.method === "POST") {
        const body = parseJson(await readBody(req));
        if (!body) { json(400, { error: "invalid JSON" }); return; }
        const content = body.content;
        const name = body.name || "api";
        const fromAddress = req.socket.remoteAddress || "";
        const sender = name + (fromAddress ? `@${fromAddress}` : "");
        if (!content) {
          json(400, { error: "content is required" });
          return;
        }

        // Encoding sanity check — reject mojibake / invalid-UTF-8 input with
        // a clear 400 so the caller notices and retries, rather than letting
        // the classifier hallucinate meaning out of garbled bytes. Triggered
        // when the message contains a high density of U+FFFD replacement
        // characters (Node puts these where a byte sequence was not decodable
        // as UTF-8 — typical when a client sends cp1251/windows-1252 bytes
        // with Content-Type: application/json but no charset). See failure
        // 2026-04-21 where Windows bash + curl -d sent mojibake and Flint
        // invented "mark task as in progress" for a Russian "delete the task".
        {
          const s = String(content);
          const replacementCount = (s.match(/\uFFFD/g) || []).length;
          const ratio = replacementCount / Math.max(s.length, 1);
          if (replacementCount >= 3 && ratio > 0.05) {
            json(400, {
              error: "content appears encoding-corrupted",
              detail: `${replacementCount} U+FFFD replacement chars (${Math.round(ratio * 100)}% of input). Send the body as UTF-8 — the client is likely encoding Russian/non-ASCII text as cp1251 or latin-1.`,
              replacement_count: replacementCount,
            });
            return;
          }
        }
        // Enable autonomous mode via API
        if (body.autonomous) {
          app.autonomous = true;
          try {
            const { resetAutonomous } = await import("../bus/drain-loop.js");
            resetAutonomous();
          } catch {}
        }

        // Reserved slash commands — intercept BEFORE the bus, mirroring the
        // TUI path at src/index.js:508. Without this, messages like /mcp or
        // /restart sent via the API land in the classifier+LLM pipeline and
        // are interpreted as natural-language tasks. See
        // the 2026-04-21 autonomous-loop incident where a user's /mcp was
        // swallowed by a self-continue loop. Bus PRIORITY already declares
        // USER=0 "TUI input, /commands" as highest priority — this makes
        // the API path consistent with that declaration.
        const trimmedContent = String(content).trim();
        const { isSlashCommand, tryHandleCommand } = await import("../commands/registry.js");
        if (isSlashCommand(trimmedContent)) {
          try {
            const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, "");
            const stateBefore = store.getState();
            const fromLineId = stateBefore.nextLineId || 0;
            const handled = await tryHandleCommand(trimmedContent, store);
            if (handled) {
              const stateAfter = store.getState();
              const newLines = (stateAfter.lines || []).filter((l) => l.id >= fromLineId);
              const output = newLines.map((l) => stripAnsi(l.text || "").trimEnd()).join("\n");
              const cmd = trimmedContent.split(/\s/)[0];
              json(200, { status: "done", handled_as: "slash_command", command: cmd, output });
              return;
            }
            // Unrecognised slash — match TUI "Unknown command" behaviour
            // and short-circuit. Don't forward to the LLM.
            const cmd = trimmedContent.split(/\s/)[0];
            json(200, {
              status: "done",
              handled_as: "unknown_command",
              command: cmd,
              output: `Unknown command: ${cmd}. Type /help for available commands.`,
            });
            return;
          } catch (err) {
            // If the command infrastructure isn't initialised (e.g. server
            // started before commands registered), fall through to the bus
            // so the message isn't lost.
          }
        }

        const syncMode = url.searchParams.get("sync") === "true" || body.sync === true;
        const streamMode = url.searchParams.get("stream") === "true" || body.stream === true;

        // All API messages go through bus — sync and async use the same path
        try {
          const busMod = await import("../bus/index.js");
          const drainLoop = await import("../bus/drain-loop.js");
          const { id: messageId } = busMod.push({
            channel: "api",
            content,
            priority: busMod.PRIORITY.API,
            source: sender,
            metadata: syncMode ? JSON.stringify({ sync: true, autonomous: body.autonomous }) : undefined,
            sessionId: store.getState().sessionId,
          });
          drainLoop.notify();

          if (streamMode) {
            // SSE streaming: open event-stream, forward tokens in real time
            try {
              const { createPipe, pipeToResponse, closePipe } = await import("./stream-pipe.js");
              const pipe = createPipe(messageId);
              pipeToResponse(pipe, res, messageId);
              // Wait for result, then close pipe
              const result = await drainLoop.waitForResult(messageId, 300000); // 5min for streaming
              pipe.emit("event", { type: "result", data: result });
              closePipe(messageId);
            } catch (err) {
              try { res.end(); } catch {}
            }
            return;
          }

          if (syncMode) {
            // Sync: wait for drain loop to process.
            // RX-2 fix: on client disconnect, call drainLoop.abortMessage(id)
            // which aborts the in-flight processing controller. The agent loop
            // then throws AbortError, drain loop's try/catch/finally properly
            // calls bus.fail(), and the processing slot is released.
            let clientGone = false;
            const onClose = () => {
              clientGone = true;
              try { drainLoop.abortMessage(messageId); } catch {}
            };
            req.on("close", onClose);

            try {
              const result = await drainLoop.waitForResult(messageId, 180000);
              if (clientGone) return; // client gone, do not write response
              if (result.error) {
                json(result.error === "timeout" ? 408 : 500, { error: result.error });
              } else {
                json(200, result);
              }
            } catch (err) {
              if (!clientGone) {
                json(500, { error: err.message });
              }
            } finally {
              try { req.off("close", onClose); } catch {}
            }
          } else {
            // Async: return messageId immediately, client polls GET /message/:id
            json(202, { messageId, status: "pending" });
          }
        } catch (err) {
          json(500, { error: err.message });
        }
        return;
      }

      // GET /message/:id -- poll for async message result
      if (url.pathname.startsWith("/message/") && req.method === "GET") {
        const id = parseInt(url.pathname.split("/")[2], 10);
        if (!id || isNaN(id)) {
          json(400, { error: "invalid message id" });
          return;
        }
        try {
          const busMod = await import("../bus/index.js");
          const { getAsyncResult } = await import("../bus/drain-loop.js");
          const msg = busMod.getMessage(id);
          if (!msg) {
            json(404, { error: "message not found" });
            return;
          }
          const response = {
            messageId: msg.id,
            status: msg.status,
            channel: msg.channel,
            createdAt: msg.created_at,
            processedAt: msg.processed_at,
          };
          if (msg.status === "done" || msg.status === "failed") {
            // Try full result from memory first, fall back to DB (truncated)
            const asyncResult = getAsyncResult(id);
            if (asyncResult) {
              response.response = asyncResult.response;
              response.stats = asyncResult.stats;
              // A poller cannot tell a finished turn from one that died on a 429
              // or an expired key without stop_reason, and cannot tell what the
              // agent actually did without toolCalls. Both were being dropped here.
              response.stop_reason = asyncResult.stop_reason;
              response.toolCalls = asyncResult.toolCalls || [];
              if (asyncResult.error) response.error = asyncResult.error;
            } else {
              // Fallback: DB result (may be truncated to 500 chars)
              response.result = msg.result;
              if (msg.status === "failed") response.error = msg.result;
            }
          }
          json(200, response);
        } catch (err) {
          json(500, { error: err.message });
        }
        return;
      }

      // GET /status -- session info
      if (url.pathname === "/status" && req.method === "GET") {
        const s = store.getState();
        json(200, {
          model: s.model,
          messages: s.messages.length,
          alive: true,
          // A bench harness cannot sum the per-turn figures and get the truth:
          // a turn it abandoned on a timeout still spent money it never saw.
          // The session total is the only honest number, so serve it, and the
          // per-source split with it, so "what is that made of" has an answer
          // without reading the session file.
          usage: {
            cost: s.sessionCost,
            estimated: s.sessionCostEstimated,
            promptTokens: s.sessionPromptTokens,
            completionTokens: s.sessionCompletionTokens,
            cachedTokens: s.sessionCachedTokens,
            bySource: s.sessionUsageBySource,
          },
        });
        return;
      }

      // POST /restart -- graceful restart (same as /restart TUI command).
      // Mirrors src/commands/commands.js:"/restart" — saves session then
      // exits with code 42 so the launcher (src/launcher.js) brings the
      // agent back up. Token-protected via authMiddleware above; no
      // request body required.
      if (url.pathname === "/restart" && req.method === "POST") {
        try {
          const s = store.getState();
          const { saveSession } = await import("../sessions.js");
          // Mirror the /restart TUI command: do NOT persist `plan` or
          // pendingAction across restart — that caused autonomous-loop
          // stickiness after 2026-04-21 (plan resumed in fresh process).
          await saveSession(s.sessionId, {
            messages: s.messages,
            model: s.model,
            profile: s._profile,
            inputHistory: s.inputHistory,
            lastSummary: s.lastSummary,
            pastedImages: s.pastedImages,
            // The restart continues this session now, cost included.
            provider: s.provider,
            sessionCost: s.sessionCost,
            sessionPromptTokens: s.sessionPromptTokens,
            sessionCompletionTokens: s.sessionCompletionTokens,
          });
        } catch {}
        json(202, { status: "restarting", exitCode: 42, sessionId: store.getState().sessionId });
        // Delay so the HTTP response actually reaches the client.
        const { restartKeepingSession } = await import("../restart.js");
        restartKeepingSession(store.getState().sessionId, 150);
        return;
      }

      // GET /bus/log -- recent bus events for monitoring
      if (url.pathname === "/bus/log" && req.method === "GET") {
        const { recentEvents, stats } = await import("../bus/index.js");
        const limit = parseInt(url.searchParams?.get("limit") || "50", 10);
        json(200, { events: recentEvents(limit), stats: stats() });
        return;
      }

      // GET /bus/stats -- bus queue statistics
      if (url.pathname === "/bus/stats" && req.method === "GET") {
        const { stats } = await import("../bus/index.js");
        const { isProcessing } = await import("../bus/drain-loop.js");
        json(200, { ...stats(), drainRunning: isProcessing() });
        return;
      }

      // POST /dataset -- child agents push datasets
      if (url.pathname === "/dataset" && req.method === "POST") {
        const body = parseJson(await readBody(req));
        if (!body) { json(400, { error: "invalid JSON" }); return; }
        const { label, columns, rows } = body;
        if (!columns || !rows) { json(400, { error: "columns and rows required" }); return; }
        const id = store.getState().addDataset({ label: label || "remote", columns, rows, source: "api" });
        json(201, { ok: true, id });
        return;
      }

      // GET /datasets -- list active datasets
      if (url.pathname === "/datasets" && req.method === "GET") {
        const datasets = store.getState().datasets;
        const list = Object.values(datasets).map((ds) => ({
          id: ds.id, label: ds.label, rows: ds.rows.length,
          page: ds.page, totalPages: Math.ceil(ds.rows.length / ds.pageSize),
        }));
        json(200, { datasets: list });
        return;
      }

      // GET /history -- conversation history (supports ?limit=N&offset=M)
      if (url.pathname === "/history" && req.method === "GET") {
        const messages = store.getState().messages;
        const limit = parseInt(url.searchParams.get("limit")) || messages.length;
        const offset = parseInt(url.searchParams.get("offset")) || 0;
        const slice = messages.slice(offset, offset + limit);
        json(200, { messages: slice, total: messages.length, offset, limit });
        return;
      }

      // GET /plan -- current task plan
      if (url.pathname === "/plan" && req.method === "GET") {
        json(200, { plan: getPlan ? getPlan() : null });
        return;
      }

      // GET /model -- current model and pricing
      if (url.pathname === "/model" && req.method === "GET") {
        const s = store.getState();
        json(200, {
          model: s.model,
          pricing: s.pricing
            ? {
                prompt: +(s.pricing.prompt * 1e6).toFixed(2),
                completion: +(s.pricing.completion * 1e6).toFixed(2),
              }
            : null,
        });
        return;
      }

      // GET /queue -- list pending bus messages
      if (url.pathname === "/queue" && req.method === "GET") {
        const { pending, stats } = await import("../bus/index.js");
        json(200, { queue: pending(), stats: stats() });
        return;
      }

      // DELETE /queue -- flush bus queue
      if (url.pathname === "/queue" && req.method === "DELETE") {
        const { flush } = await import("../bus/drain-loop.js");
        const { stats } = await import("../bus/index.js");
        const before = stats().pending;
        flush();
        json(200, { ok: true, flushed: before });
        return;
      }

      // POST /continue -- resume unfinished auto work (shortcut for POST /command {command:"/continue"})
      if (url.pathname === "/continue" && req.method === "POST") {
        if (onCommand) {
          const result = await onCommand("/continue");
          json(200, { ok: true, result });
        } else {
          json(501, { error: "commands not supported" });
        }
        return;
      }

      // POST /command -- execute REPL command (/clear, /new, etc.)
      if (url.pathname === "/command" && req.method === "POST") {
        const body = parseJson(await readBody(req));
        if (!body) { json(400, { error: "invalid JSON" }); return; }
        const command = body.command;
        if (!command) {
          json(400, { error: "command is required" });
          return;
        }
        if (onCommand) {
          const result = await onCommand(command);
          json(200, { ok: true, result });
        } else {
          json(501, { error: "commands not supported" });
        }
        return;
      }

      // POST /stop -- abort current agent execution (outside the lock)
      if (url.pathname === "/stop" && req.method === "POST") {
        const ac = getAbortController?.();
        if (ac) {
          ac.abort();
          onStop?.();
          json(200, { ok: true, message: "aborted" });
        } else {
          json(200, { ok: true, message: "nothing running" });
        }
        return;
      }

      json(404, { error: "not found" });
    } catch (err) {
      json(500, { error: err.message });
    }
  });

  // Try configured port, then scan up to find a free one, UNLESS the caller
  // named the port on purpose. Scanning is right for a person starting a
  // second Flint by hand and wrong for anything driven by another program: a
  // bench subject asked for 3001 and silently answering on 3003 means the
  // harness talked to whatever else was listening. Reported through `error` so
  // the caller can say so and exit rather than run on the wrong port.
  return new Promise((resolve) => {
    let tryPort = port;
    const maxAttempts = strictPort ? 0 : 20;

    server.on("error", (err) => {
      process.stderr.write(`[server] Port ${tryPort} error: ${err.code} ${err.message}\n`);
      if (strictPort) {
        log.error(`Port ${port} was requested explicitly and is not available`, { code: err.code });
        resolve({ server: null, port: null, error: `port ${port} unavailable (${err.code})` });
        return;
      }
      if ((err.code === "EADDRINUSE" || err.code === "EACCES") && tryPort - port < maxAttempts) {
        log.debug(`Port ${tryPort} unavailable (${err.code}), trying next`);
        tryPort++;
        server.listen(tryPort, API_HOST);
      } else {
        log.error(`Failed to bind (tried ports ${port}-${tryPort})`, { code: err.code, message: err.message });
        resolve({ server, port });
      }
    });
    server.on("listening", () => {
      const actualPort = server.address().port;
      if (actualPort !== port) {
        log.warn(`Port ${port} unavailable, using ${actualPort}`);
      } else {
        log.info(`Listening on port ${actualPort}`);
      }
      resolve({ server, port: actualPort });
    });
    server.listen(tryPort, API_HOST);
  });
}
