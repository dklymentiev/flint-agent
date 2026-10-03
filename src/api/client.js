// The one door to the provider.
//
// Every paid call leaves from here, and leaves only after the budget has been
// consulted. There used to be four other ways out — the intent classifier, the
// fact extractor, the outcome ask, and a stray copy of the benchmark judge —
// each with its own `fetch` and none of them within sight of a ceiling. The
// ceilings, meanwhile, were checked after the fact against numbers that did not
// include those calls. See src/agent/usage.js for the notebook side of it.
//
// A new caller must come through here. tests/unit/api/one-door.test.js walks
// src/ and fails the build if a second door appears.

import { freeRequestFields, paymentRequiredMessage, recordFreeRequest, createServedModelNotifier } from "../free-models.js";
import { config } from "../config.js";
import { getProvider } from "../providers/registry.js";
import * as openaiAdapter from "../providers/adapters/openai.js";
import * as anthropicAdapter from "../providers/adapters/anthropic.js";
import { fetchModelInfo as fetchModelInfoFromProvider } from "../providers/models.js";
import { assertWithinBudget, recordUsage } from "../agent/usage.js";

function getAdapter() {
  const provider = getProvider(config.provider);
  if (!provider) return { adapter: openaiAdapter, provider: getProvider("openrouter") };
  if (provider.format === "anthropic") return { adapter: anthropicAdapter, provider };
  return { adapter: openaiAdapter, provider };
}

/**
 * RX-1 fix: Combine external AbortSignal with an internal timeout signal.
 * Returns a signal that aborts when either fires. Compatible with Node 18+.
 */
function combineAbortSignals(external, timeoutMs) {
  const combined = new AbortController();
  let timeoutHandle = null;
  let externalHandler = null;

  const cleanup = () => {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (external && externalHandler) {
      try { external.removeEventListener("abort", externalHandler); } catch {}
    }
  };

  // External signal already aborted — return immediately
  if (external?.aborted) {
    combined.abort(external.reason);
    return { signal: combined.signal, cleanup };
  }

  // Set up timeout
  timeoutHandle = setTimeout(() => {
    combined.abort(new Error(`API call exceeded timeout of ${timeoutMs}ms`));
  }, timeoutMs);

  // Forward external abort
  if (external) {
    externalHandler = () => combined.abort(external.reason);
    external.addEventListener("abort", externalHandler, { once: true });
  }

  return { signal: combined.signal, cleanup };
}

/**
 * Call the provider. The only function in src/ that does.
 *
 * @param {Array} messages
 * @param {Array} tools
 * @param {Function} onToken
 * @param {object} [opts]
 * @param {AbortSignal} [opts.signal]
 * @param {string} [opts.model] model for this call; defaults to config.model
 * @param {string} [opts.source="agent"] which part of Flint is spending. Must
 *   be one of USAGE_SOURCES — it is what the bill is broken down by.
 * @param {number} [opts.maxTokens] defaults to config.maxResponseTokens
 * @param {number} [opts.temperature]
 * @param {number} [opts.seed]
 * @param {object} [opts.responseFormat] e.g. {type: "json_object"}
 * @param {number} [opts.timeoutMs] hard ceiling for this call
 * @param {boolean} [opts.stream=true] side calls want the whole answer at once
 * @throws {BudgetExceededError} before sending anything, when a ceiling is spent
 */
// Free mode notices go to the console through this (index.js sets it).
const notifyServedModel = createServedModelNotifier();
let freeNoticeSink = null;
export function setFreeNoticeSink(fn) { freeNoticeSink = fn; }

export async function chatCompletion(messages, tools, onToken, {
  signal,
  model: modelOverride,
  source = "agent",
  maxTokens,
  temperature,
  seed,
  responseFormat,
  timeoutMs,
  stream: streamOpt = true,
} = {}) {
  // FIRST, before anything is built or sent. The ceilings are read live because
  // /budget can move them mid-session; 0 means unlimited, which is the default.
  // The run ceiling of an autonomous run lives in the ledger and is checked in
  // the same call, so all three refuse in one place.
  assertWithinBudget({ perAction: config.maxCostPerAction, session: config.sessionBudget });

  // Strip internal metadata fields before sending to API
  const cleanMessages = messages.map((m) => {
    if (m._toolName || m._toolArgs || m._compressed) {
      const { _toolName, _toolArgs, _compressed, ...clean } = m;
      return clean;
    }
    return m;
  });

  // Detect if messages contain images — disable streaming for image requests
  const hasImages = cleanMessages.some((m) =>
    Array.isArray(m.content) && m.content.some((p) => p.type === "image_url")
  );

  const { adapter, provider } = getAdapter();
  const apiKey = config.apiKey;
  const stream = streamOpt && !hasImages;

  const headers = adapter.buildHeaders(provider, apiKey);
  const effectiveModel = modelOverride || config.model;
  const body = adapter.buildBody(
    cleanMessages,
    effectiveModel,
    tools,
    maxTokens || config.maxResponseTokens,
    stream,
    { temperature, seed, responseFormat },
  );
  // OpenRouter's provider preference, for the main model only. One model is
  // served by several hosts that bill and answer differently (DigitalOcean
  // billed cache reads at 27x Xiaomi's rate on 2026-09-28 and once answered a
  // file-sorting task about Kubernetes). A side call on another model must not
  // inherit "only these hosts": they may not serve it.
  if (config.openrouterProvider && provider?.id === "openrouter" && effectiveModel === config.model) {
    body.provider = config.openrouterProvider;
  }
  // Free mode: the main model's request names the fallbacks, and OpenRouter
  // answers from the first that works (free-models.js).
  Object.assign(body, freeRequestFields({ chain: config.freeChain, provider, model: effectiveModel, mainModel: config.model }));
  const freeCall = !!config.freeChain?.includes(effectiveModel);
  const url = adapter.getChatUrl(provider);

  // Env-gated snapshot of the exact prompt going to the LLM. Used to compare
  // Flint's wrapped prompt vs. raw model behaviour on the same task. Writes
  // one JSON per call to ~/.flint/agent-prompt-snapshots/.
  // Only the main loop: this dump is an instrument for comparing Flint's
  // wrapped prompt against a raw one, and now the classifier, the fact
  // extractor and the outcome ask come through here too. Mixing their payloads
  // into the same directory would quietly change what the measurement means.
  if (process.env.FLINT_DUMP_AGENT_PROMPT === "1" && source === "agent") {
    try {
      const { writeFileSync, existsSync, mkdirSync } = await import("node:fs");
      const { join } = await import("node:path");
      const { homedir } = await import("node:os");
      const dir = join(homedir(), ".flint", "agent-prompt-snapshots");
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const ts = Date.now();
      const file = join(dir, `${ts}.json`);
      writeFileSync(file, JSON.stringify({
        ts,
        model: effectiveModel,
        url,
        messages: cleanMessages,
        tools: tools,
        body_summary: {
          message_count: cleanMessages.length,
          tool_count: Array.isArray(tools) ? tools.length : 0,
          total_chars: JSON.stringify(cleanMessages).length,
        },
      }, null, 2));
    } catch {}
  }

  // RX-1 fix: hard timeout on API call (configurable).
  // Prevents agent loop from hanging indefinitely when provider is slow
  // or when streaming never terminates. Combines with external abort signal.
  //
  // 600s, not 120: the ceiling is on the whole call, and a reasoning model on a
  // long context was cut off mid-answer and paid for again. The SWE pilot of
  // 2026-09-26 lost three calls in a row that way and the turn ended with
  // "API error (3x)". 600 is the OpenAI SDK default.
  const API_TIMEOUT = timeoutMs || parseInt(process.env.AGENT_API_TIMEOUT || "600", 10) * 1000;
  const { signal: effectiveSignal, cleanup } = combineAbortSignals(signal, API_TIMEOUT);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: effectiveSignal,
    });

    if (!response.ok) {
      const text = await response.text();
      // Surface rate-limit / quota errors explicitly so the user sees them.
      // Fail-fast on daily / monthly quota (no retry would help).
      if (response.status === 429) {
        const retryAfter = response.headers.get("retry-after");
        const err = new Error(
          `Rate limit (429): ${text.slice(0, 300)}${retryAfter ? ` | retry-after: ${retryAfter}s` : ""}`
        );
        err.statusCode = 429;
        err.isRateLimit = true;
        err.retryAfter = retryAfter ? parseInt(retryAfter, 10) : null;
        throw err;
      }
      if (response.status === 401 || response.status === 403) {
        const err = new Error(`Auth failed (${response.status}): check API key for provider '${provider?.id || "unknown"}'. ${text.slice(0, 200)}`);
        err.statusCode = response.status;
        err.isAuthError = true;
        throw err;
      }
      if (response.status === 402) {
        const err = new Error(paymentRequiredMessage(freeCall) || `Payment required (402): insufficient credits. ${text.slice(0, 200)}`);
        err.statusCode = 402;
        err.isQuotaError = true;
        throw err;
      }
      // The status travels with the error: a caller deciding whether to retry
      // needs to tell a client error from a transient one, and parsing it back
      // out of the message is not a decision, it is a guess.
      throw Object.assign(new Error(`API ${response.status}: ${text}`), { statusCode: response.status });
    }

    const result = !stream
      ? adapter.parseResponse(await response.json(), onToken)
      : await adapter.parseStreamResponse(response, onToken);

    // Free mode: today's count for the footer, and one line when a fallback
    // answered instead of the primary.
    if (freeCall) {
      recordFreeRequest();
      if (effectiveModel === config.model) {
        const note = notifyServedModel(config.model, result.servedModel);
        if (note) freeNoticeSink?.(note);
      }
    }

    // The caller does not record anything. Two sources were declared and never
    // wired to a counter before this moved here, both times
    // because recording was somebody else's job.
    recordUsage(source, result.usage);
    return result;
  } finally {
    cleanup();
  }
}

export async function fetchModelInfo(modelId) {
  // Use provider-aware model info fetching
  const providerId = config.provider;
  const info = await fetchModelInfoFromProvider(providerId, modelId);
  if (info) return info;

  // Fallback: try OpenRouter directly (backward compat)
  if (providerId === "openrouter") {
    try {
      const res = await fetch("https://openrouter.ai/api/v1/models", {
        headers: { Authorization: `Bearer ${config.apiKey}` },
      });
      if (!res.ok) return null;
      const data = await res.json();
      const model = data.data?.find((m) => m.id === modelId);
      if (!model?.pricing) return null;
      return {
        prompt: parseFloat(model.pricing.prompt),
        completion: parseFloat(model.pricing.completion),
        contextLength: model.context_length || null,
      };
    } catch {
      return null;
    }
  }

  return null;
}
