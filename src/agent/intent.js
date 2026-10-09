// Intent classifier — one cheap LLM call BEFORE the main agent loop.
//
// The classifier reads session context (summary + recent messages + new message)
// PLUS the live list of available tools from the registry, and returns a manifest
// with:
//   - intent class (creative_text, memory_read, shell_multi, ...)
//   - concrete tool names picked from the registry
//   - max_steps and expected output shape
//
// Tool names are NOT hardcoded in the manifest — they come from the live registry
// at call time. Adding a tool in the registry makes it automatically eligible for
// the classifier without any code changes here.

import { getSpendLevel, spendSettings } from "../spend.js";
import { createHash } from "node:crypto";
import { intentTimeoutMs } from "./intent-timeout.js";
import { appendFileSync, mkdirSync, statSync, renameSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homeStateDir } from "../data-dir.js";
import { config } from "../config.js";
import { createLogger } from "../logging/logger.js";
import { INTENTS, formatIntentCatalog, resolveIntent } from "./intent-manifest.js";
import { chatCompletion } from "../api/client.js";
import { CORE_TOOLS, TOOL_SEARCH_NAME, loadedToolNames } from "../tools/tool-search.js";

// Load the classifier prompt from config/classifier-prompt.md. The file is the
// source of truth for classifier behaviour — edits there propagate on restart
// with no code change. The file has three parts separated by `---`:
// the frontmatter header, the main SYSTEM+rules body, and the SCHEMA block.
// We extract the two we need (system body + schema block) at module init.
const _thisFile = fileURLToPath(import.meta.url);
const _promptPath = join(dirname(_thisFile), "..", "..", "config", "classifier-prompt.md");
const _promptRaw = readFileSync(_promptPath, "utf8");
const _parts = _promptRaw.split(/^---\s*$/m).map(s => s.trim()).filter(Boolean);
// Expected: [header, body, schema]. Fall back to full file if split fails.
const _body = _parts[1] || _promptRaw;
const _schemaSection = _parts[2] || "";
const _schemaMatch = _schemaSection.match(/```json\s*([\s\S]*?)```/);

const log = createLogger("intent");

// ── LRU cache for classifier results ──
// Same user message + same recent messages + same tool list = same classification.
// No point paying for the LLM call twice in a short window.
const CACHE_MAX = 50;

// With the classifier off, up to this many MCP tools are handed over whole;
// more go through tool_search (fallbackManifest). Set by the spend mode
// (spend.js: economy 10, normal 30, generous 200); FLINT_MCP_INLINE_MAX wins.
export function mcpInlineMax(env = process.env, level = getSpendLevel(env)) {
  const v = parseInt(env.FLINT_MCP_INLINE_MAX, 10);
  return Number.isFinite(v) ? v : spendSettings(level).mcpInlineMax;
}
const CACHE_TTL_MS = 5 * 60 * 1000;
const _cache = new Map(); // key → {manifest, ts}
// The classifier per-attempt budget is read from INTENT_TIMEOUT_MS via its own
// module (src/agent/intent-timeout.js) so it can be tested without importing the
// config, the API client and the tool manifest. A hard deadline here is what made a
// test depend on machine load: classifyIntent catches its own errors and falls back to
// the all-tools manifest, so a blown deadline looks like a valid classification.
// See that file.

function cacheKey(newMessage, recentMessages, availableTools) {
  const h = createHash("sha256");
  h.update(newMessage || "");
  h.update("|");
  for (const m of (recentMessages || [])) {
    h.update(m.role || "");
    h.update(":");
    h.update(typeof m.content === "string" ? m.content : JSON.stringify(m.content || ""));
    h.update("\n");
  }
  h.update("|");
  for (const t of (availableTools || [])) {
    h.update((t.function?.name || t.name || "") + ",");
  }
  return h.digest("hex");
}

function cacheGet(key) {
  const entry = _cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    _cache.delete(key);
    return null;
  }
  // LRU: move to end
  _cache.delete(key);
  _cache.set(key, entry);
  return entry.manifest;
}

function cacheSet(key, manifest) {
  if (_cache.size >= CACHE_MAX) {
    const oldest = _cache.keys().next().value;
    if (oldest !== undefined) _cache.delete(oldest);
  }
  _cache.set(key, { manifest, ts: Date.now() });
}

// ── Prompt injection guard ──
// A user whose message mentions classifier output keywords could try to disable
// tool access by steering classification toward text-only intents. We detect
// obvious markers and, if present, skip the classifier entirely and return the
// full-tool fallback. The attacker cannot narrow the tool surface this way.
const INJECTION_PATTERNS = [
  /\bclassif(y|ied|ication)\s+as\b/i,
  /\bintent\s*[:=]\s*["']?[a-z_]+/i,
  /\btools\s*[:=]\s*\[/i,
  /\bneedsTools\b/i,
  /\bmax_?steps\s*[:=]/i,
];

function looksLikeInjection(text) {
  if (!text || typeof text !== "string") return false;
  return INJECTION_PATTERNS.some(re => re.test(text));
}

// ── Shadow log of classification decisions ──
// Every classification is appended so we can later measure accuracy against
// E2E outcomes. No runtime cost beyond one async-fs append.
const DECISIONS_FILE = join(homeStateDir(), "intent-decisions.jsonl");
const DECISIONS_MAX_BYTES = 10 * 1024 * 1024; // 10 MB → archive + start fresh
let _logCallCount = 0;

// Rotate the decisions log if it crosses the size threshold. Archive name is
// `intent-decisions-YYYY-MM-DD.jsonl`; if an archive for today already exists
// (rare), the timestamp is appended to keep history distinct. Best-effort —
// failures are swallowed, logging continues on the (unrotated) file.
function maybeRotateDecisions() {
  try {
    if (!existsSync(DECISIONS_FILE)) return;
    const st = statSync(DECISIONS_FILE);
    if (st.size < DECISIONS_MAX_BYTES) return;
    const date = new Date().toISOString().slice(0, 10);
    let archive = DECISIONS_FILE.replace(/\.jsonl$/, `-${date}.jsonl`);
    if (existsSync(archive)) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      archive = DECISIONS_FILE.replace(/\.jsonl$/, `-${stamp}.jsonl`);
    }
    renameSync(DECISIONS_FILE, archive);
  } catch {}
}

function logDecision(entry) {
  try {
    mkdirSync(dirname(DECISIONS_FILE), { recursive: true });
    // Gate the size check to avoid a statSync on every classification; once
    // per 100 decisions is enough (max 100 extra log lines before rotation).
    if (_logCallCount++ % 100 === 0) maybeRotateDecisions();
    appendFileSync(DECISIONS_FILE, JSON.stringify(entry) + "\n", "utf-8");
  } catch {
    // Logging is best-effort — never break classification on log failure
  }
}

// Classifier system prompt — body loaded from config/classifier-prompt.md at
// module init. The markdown file is the source of truth for classifier rules.
// The live intent catalog (from intent-manifest.js) is appended here so that
// adding/removing intents in code is automatically reflected without editing
// the markdown. AVAILABLE_TOOLS is appended per-call in buildUserPrompt.
const CLASSIFIER_SYSTEM = `${_body}\n\n## INTENT_CLASSES\n\n${formatIntentCatalog()}\n`;

// Schema hint — extracted from the fenced ```json block in the SCHEMA section
// of config/classifier-prompt.md. Fallback to a minimal inline schema if the
// markdown file's SCHEMA block is missing or malformed.
const SCHEMA_HINT = (_schemaMatch && _schemaMatch[1].trim()) || `{
  "intent": "<one of the class names above>",
  "tools": ["<tool_name_from_the_list>", ...],
  "assessment": "<normal|dangerous|overscoped|ambiguous|nonsensical|impossible>",
  "requires_prior_tool_call": [],
  "user_wants": "<one sentence paraphrase>",
  "reason": "<why this class>"
}`;

/**
 * Classify a user request in its conversation context.
 *
 * @param {object} ctx
 * @param {string} ctx.newMessage         — the new user message (required)
 * @param {Array}  ctx.availableTools     — live tool defs from registry [{type,function:{name,description}},...]
 * @param {string} [ctx.sessionSummary]   — compact summary of the session so far (optional)
 * @param {Array}  [ctx.recentMessages]   — last few {role, content} messages (optional)
 * @returns {Promise<object>} manifest: {intent, tools, max_steps, expected, user_wants, reason, fallback?}
 */
export async function classifyIntent(ctx) {
  const { newMessage, sessionSummary, recentMessages, availableTools } = ctx;

  // Headless mode bypass: when Flint runs as a headless subprocess (e.g. the
  // SWE-bench runner, or any CLI `--headless --task ...` invocation) the
  // caller's prompt is usually a long, complex code-editing brief that the
  // classifier misreads as `file_read` and caps at 3 iterations. There is no
  // interactive user to correct the classifier. Give the agent full tool
  // access and let config.maxIterations govern the budget instead.
  if (config.headless) {
    return fallbackManifest("headless mode — classifier bypassed", availableTools);
  }

  // A/B switch: no classifier call at all, the built-in tools every turn, no
  // assessment gate. Across 2026-09-26 the classifier's tool picks caused three
  // of Flint's five losses (no web on a SWE task, every tool taken away from
  // an explicit delete, three operator tools for a browser task). This measures
  // what the turn does without it.
  if (process.env.FLINT_NO_CLASSIFIER === "1") {
    return fallbackManifest("classifier disabled (FLINT_NO_CLASSIFIER)", availableTools);
  }

  // FLINT_TOOL_MODE=search: an explicit choice, so it comes before the
  // classifier-off fallback below. No classifier call. The core set, whatever
  // tool_search has loaded so far this session, and tool_search itself.
  if (process.env.FLINT_TOOL_MODE === "search") {
    const present = new Set((availableTools || []).map(t => t.function?.name || t.name).filter(Boolean));
    const names = [...CORE_TOOLS, ...loadedToolNames(), TOOL_SEARCH_NAME].filter(n => present.has(n));
    return { ...fallbackManifest("tool search mode", availableTools), tools: [...new Set(names)], fallbackScope: "search" };
  }

  // No INTENT_MODEL: the classifier is off, not an error.
  if (!config.intentModel) {
    return fallbackManifest("classifier disabled (INTENT_MODEL not set)", availableTools);
  }

  if (!newMessage || typeof newMessage !== "string") {
    return fallbackManifest("empty or non-text message", availableTools);
  }

  // Prompt injection guard — if the user message contains classifier-control
  // keywords, skip classification entirely and give the agent full tool access.
  // An attacker cannot use this path to narrow the tool surface.
  if (looksLikeInjection(newMessage)) {
    log.warn("intent: injection pattern detected, using full-tool fallback");
    const fallback = fallbackManifest("injection pattern in user message", availableTools);
    logDecision({
      ts: new Date().toISOString(),
      message: newMessage.slice(0, 200),
      intent: fallback.intent,
      tools: fallback.tools.length,
      assessment: fallback.assessment,
      fallback: true,
      reason: "injection_guard",
    });
    return fallback;
  }

  // Cache: identical input in a short window reuses the previous decision.
  const key = cacheKey(newMessage, recentMessages, availableTools);
  const cached = cacheGet(key);
  if (cached) {
    log.debug("intent: cache hit", { intent: cached.intent });
    return cached;
  }

  // Build the user-side prompt for the classifier.
  //
  // Classifier stays lightweight on purpose: intent catalog + available
  // tools + user message + schema. Project rules (FLINT.md), memory
  // layers, profile, OS hints etc. are the agent loop's concern — not
  // the classifier's. Loading them here bloats the prompt (~4K chars of
  // project rules for a ~300-token decision) without improving tool
  // picks. The agent loop still gets FLINT.md and applies its guidance
  // when forming the actual tool call arguments.
  //
  // ORDER MATTERS — LLMs have strong primacy + recency bias and a well-known
  // "lost in the middle" problem. The three things the classifier MUST
  // consider carefully are (a) the user's new message, (b) the tool catalog
  // it picks from, (c) the JSON schema for the response. Those go at the
  // start (primacy) or the very end (recency). Conversation history is
  // deprioritised context — it goes in the middle, wrapped in a block that
  // explicitly marks it as "for disambiguation only, do not let it drive
  // tool choice". Previous layout had the new message 2nd-to-last and the
  // tool catalog in the middle — observed 2026-04-21: when preceding turns
  // in the session were about shell/ssh/docker, the classifier carried that
  // bias forward and routed "sum tags in planner" → shell_command instead
  // of the mcp_planner_* tools that were right there in the catalog.
  const parts = [];

  // 1) NEW MESSAGE first — highest attention.
  parts.push("NEW MESSAGE:\n" + newMessage.slice(0, 1000));

  // 2) AVAILABLE TOOLS right after — the classifier must pick from this list.
  const toolList = Array.isArray(availableTools) ? availableTools : [];
  if (toolList.length) {
    const toolLines = toolList
      .map(t => {
        const name = t.function?.name || t.name;
        const desc = (t.function?.description || t.description || "").replace(/\s+/g, " ").slice(0, 120);
        return name ? `  ${name} — ${desc}` : null;
      })
      .filter(Boolean)
      .join("\n");
    parts.push("AVAILABLE TOOLS:\n" + toolLines);
  }

  // 3) Session context in the middle, framed as weak context so the model
  //    treats it as disambiguation help, not as a driver of tool choice.
  if (sessionSummary && sessionSummary.trim()) {
    parts.push(
      "SESSION SUMMARY (context only — do not let this override tool choice from the new message):\n" +
      sessionSummary.trim().slice(0, 1000),
    );
  }
  if (Array.isArray(recentMessages) && recentMessages.length) {
    const historyLines = [];
    for (const m of recentMessages.slice(-5)) {
      if (!m || !m.role) continue;
      const text = typeof m.content === "string"
        ? m.content
        : Array.isArray(m.content)
          ? m.content.map(c => c.text || "").join(" ")
          : "";
      if (!text.trim()) continue;
      historyLines.push(`${m.role}: ${text.slice(0, 300)}`);
    }
    if (historyLines.length) {
      parts.push(
        "RECENT MESSAGES (context only — classify the new message on its own merits, do not carry bias from previous turns):\n" +
        historyLines.join("\n"),
      );
    }
  }

  // 4) Schema at the very end — the last thing the model reads before
  //    generating its response, for maximum structural compliance.
  parts.push("Classify the NEW MESSAGE above. Return JSON matching:\n" + SCHEMA_HINT);

  const userPrompt = parts.join("\n\n");

  // Env-gated snapshot of the classifier prompt. Writes one JSON file per
  // classify call to ~/.flint/classifier-prompt-snapshots/ when
  // FLINT_DUMP_CLASSIFIER_PROMPT=1. Used to debug "why did the classifier
  // pick X" — read the file and see what the model actually saw.
  if (process.env.FLINT_DUMP_CLASSIFIER_PROMPT === "1") {
    try {
      const { writeFileSync, mkdirSync, existsSync: exists } = await import("node:fs");
      const dir = join(homeStateDir(), "classifier-prompt-snapshots");
      if (!exists(dir)) mkdirSync(dir, { recursive: true });
      const ts = Date.now();
      writeFileSync(join(dir, `${ts}.json`), JSON.stringify({
        ts,
        model: config.intentModel,
        new_message: newMessage,
        system_prompt_chars: CLASSIFIER_SYSTEM.length,
        user_prompt_chars: userPrompt.length,
        messages: [
          { role: "system", content: CLASSIFIER_SYSTEM },
          { role: "user", content: userPrompt },
        ],
      }, null, 2));
    } catch {}
  }

  // Call the classifier model with retries on transient errors (fetch failed / 5xx).
  // Through the one door: the classifier is not free, so it is subject
  // to the same ceilings as the main loop and its spend lands in the same
  // notebook without this module doing anything about it.
  let raw;
  const MAX_ATTEMPTS = 3;
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const { message } = await chatCompletion(
        [
          { role: "system", content: CLASSIFIER_SYSTEM },
          { role: "user", content: userPrompt },
        ],
        [],
        null,
        {
          source: "classifier",
          model: config.intentModel,
          maxTokens: 400,
          temperature: 0,
          // Pin sampling seed — Gemini Flash is non-deterministic even at
          // temperature=0 on boundary prompts. A fixed seed
          // gives reproducible outputs for identical inputs, which kills
          // the L1-007/L1-008 flake where the same prompt was classified
          // "normal" in one run and "impossible" in another. Constant is
          // arbitrary; what matters is that it stays the same across calls.
          seed: 42,
          responseFormat: { type: "json_object" },
          stream: false,
          timeoutMs: intentTimeoutMs(),
        },
      );
      raw = message?.content || "";
      break; // success
    } catch (err) {
      // No budget left is an answer, not a hiccup. Retrying it would only burn
      // three seconds to be refused three times.
      if (err.isBudgetError) {
        log.info("classifier skipped, budget spent", { scope: err.scope });
        return fallbackManifest(`budget exhausted (${err.scope})`, toolList);
      }
      // 4xx are client errors — don't retry. 5xx are transient — retry.
      const status = err.statusCode;
      if (status && status < 500) {
        log.warn("classifier http error", { status, attempt });
        return fallbackManifest(`classifier http ${status}`, toolList);
      }
      lastError = err.message;
      if (attempt < MAX_ATTEMPTS) {
        log.info("classifier retry", { attempt, error: err.message });
        await new Promise(r => setTimeout(r, 500 * attempt));
        continue;
      }
      log.warn("classifier call failed", { error: err.message, attempts: attempt });
      return fallbackManifest(`classifier error: ${err.message}`, toolList);
    }
  }

  if (!raw) {
    return fallbackManifest(`classifier empty after retries: ${lastError}`, toolList);
  }

  // Parse classifier JSON output
  let parsed;
  try {
    const clean = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
    parsed = JSON.parse(clean);
  } catch (err) {
    log.warn("classifier returned invalid json", { raw: raw.slice(0, 200) });
    return fallbackManifest("invalid json from classifier", toolList);
  }

  // Lenient intent validation. Smart models (Sonnet, Opus, Gemini 2.5+)
  // frequently invent descriptive intent names ("mesh_write", "tool_simple",
  // "lookup_read") that match the request semantically but are not in our
  // catalog. Their tool picks are usually correct. Previously we threw the
  // tools away and fell back to complex_multi-with-ALL-tools — which
  // defeats the classifier. Now: if the intent name is unknown but the
  // picked tools are valid, keep the tools and normalise the intent to
  // `complex_multi` (a catch-all that needsTools=true with no pattern).
  let intentName = parsed.intent;
  let spec = INTENTS[intentName];
  const liveToolNames = new Set(toolList.map(t => t.function?.name || t.name).filter(Boolean));
  const pickedRaw = Array.isArray(parsed.tools) ? parsed.tools : [];
  const validPicks = pickedRaw.filter(n => typeof n === "string" && liveToolNames.has(n));

  if (!spec) {
    if (validPicks.length > 0) {
      log.info("classifier picked unknown intent name, normalising to complex_multi", {
        original_intent: intentName,
        valid_tools: validPicks.length,
      });
      intentName = "complex_multi";
      spec = INTENTS.complex_multi;
    } else {
      log.warn("classifier picked unknown intent AND no valid tools", { intent: parsed.intent });
      return fallbackManifest(`unknown intent ${parsed.intent}`, toolList);
    }
  }

  // Resolve tools:
  // - text-only intents: always empty array (override anything the classifier returned)
  // - tool-backed: keep only names that actually exist in the live registry
  let tools;
  if (!spec.needsTools) {
    tools = [];
  } else {
    tools = validPicks;
    if (tools.length === 0) {
      // Classifier picked no valid tools for a tool-backed intent — degrade to complex_multi
      log.warn("classifier picked no valid tools for tool-backed intent, falling back", { intent: intentName, picked: pickedRaw });
      return fallbackManifest(`${intentName}: no valid tools picked`, toolList);
    }
  }

  // Validate assessment: classifier returns one of 6 classes, default to 'normal'
  // if missing or unrecognized. Bug fix 2026-04-19: previously this field was
  // dropped on the floor, making the entire assessment gate in agent.js a no-op.
  const validAssessments = new Set(["normal", "dangerous", "overscoped", "ambiguous", "nonsensical", "impossible"]);
  const assessment = validAssessments.has(parsed.assessment) ? parsed.assessment : "normal";

  // Parse requires_prior_tool_call — list of tool names that must be called
  // before the agent's final text answer. For factual codebase lookups, the
  // agent must verify via search/read instead of guessing from memory.
  // Only keep names that actually exist in the live registry.
  const requiresPrior = Array.isArray(parsed.requires_prior_tool_call)
    ? parsed.requires_prior_tool_call.filter(n => typeof n === "string" && liveToolNames.has(n))
    : [];

  const manifest = {
    intent: intentName,
    tools, // concrete tool names from live registry, or [] for text-only
    // tool_pattern (if any) widens the effective tool surface at filter time —
    // see filterToolsByManifest. Optional; only tool-backed intents set it.
    tool_pattern: spec.tool_pattern || null,
    max_steps: spec.max_steps,
    expected: spec.expected,
    // Whether a request of this class is supposed to end with something
    // different on disk. Carried from the catalog, not decided here.
    changes: spec.changes,
    user_wants: (parsed.user_wants || "").slice(0, 300),
    reason: (parsed.reason || "").slice(0, 300),
    assessment,
    requires_prior_tool_call: requiresPrior,
    fallback: false,
  };

  log.info("intent classified", {
    intent: manifest.intent,
    tools: manifest.tools.length,
    max_steps: manifest.max_steps,
    wants: manifest.user_wants,
  });

  cacheSet(key, manifest);
  logDecision({
    ts: new Date().toISOString(),
    message: newMessage.slice(0, 200),
    intent: manifest.intent,
    tools: manifest.tools,
    max_steps: manifest.max_steps,
    expected: manifest.expected,
    user_wants: manifest.user_wants,
    reason: manifest.reason,
    assessment: manifest.assessment,
    requires_prior_tool_call: manifest.requires_prior_tool_call,
    raw_requires_prior: parsed.requires_prior_tool_call, // debug — what classifier actually returned
    fallback: false,
  });

  return manifest;
}

/**
 * Build a safe fallback manifest: complex_multi with the built-in tool surface.
 * Used when classification fails for any reason.
 *
 * It used to hand over EVERY live tool, MCP surfaces included. Measured 2026-09-20 on
 * one task: 191 schemas is 33k tokens per call against 6k for the built-ins alone, the
 * turn costs about $0.022 instead of $0.003, and the agent wanders 5 to 16 steps where
 * a narrowed turn takes 2. Every expensive run that day came through this path. MCP
 * servers are optional integrations; the built-ins are the agent's own hands, so a
 * failed classification now costs the user a retry on an MCP task instead of costing
 * money and steps on every task. FLINT_FALLBACK_ALL_TOOLS=1 restores the old shape.
 *
 * 2026-10-02: hidden was too far. An operator who connected Screenbox got an agent
 * that said it had no Screenbox tools and could not do the task. Now a few MCP tools
 * (MCP_INLINE_MAX) are handed over whole, and past that tool_search lists every
 * connected server in its description and loads what the turn asks for.
 */
function fallbackManifest(reason, availableTools) {
  const spec = resolveIntent("complex_multi");
  const all = (availableTools || []).map(t => t.function?.name || t.name).filter(Boolean);
  const builtin = all.filter(n => !n.startsWith("mcp_"));
  const mcp = all.filter(n => n.startsWith("mcp_"));
  // A few MCP tools go in whole; their schemas cost little and a search would
  // be a wasted step. Past MCP_INLINE_MAX the built-ins go in with
  // tool_search, whose description lists what it can load
  // (tool-search.js mcpCatalog), plus whatever a search already loaded.
  const loaded = new Set(loadedToolNames());
  const toolNames = config.fallbackAllTools || builtin.length === 0 || mcp.length <= mcpInlineMax()
    ? all
    : [...builtin, ...mcp.filter(n => loaded.has(n))];
  return {
    intent: "complex_multi",
    tools: toolNames,
    max_steps: spec.max_steps,
    expected: spec.expected,
    changes: spec.changes,
    user_wants: "",
    reason,
    assessment: "normal", // fallback always proceeds normally — gate only fires when classifier explicitly flags
    fallback: true,
    fallbackScope: toolNames.length === all.length ? "all" : "builtin",
  };
}

/**
 * Apply an intent manifest to a list of tool definitions.
 * Returns the filtered subset the agent loop should expose to the model.
 *
 * @param {Array} allTools — full tool definitions from registry
 * @param {object} manifest — from classifyIntent()
 * @returns {Array} filtered tool definitions
 */
export function filterToolsByManifest(allTools, manifest) {
  if (!manifest) return allTools;
  const wanted = manifest.tools;
  if (!Array.isArray(wanted)) return allTools;
  // Tree-mode widening: when the resolved intent spec carries a tool_pattern
  // regex, union the classifier's picks with all tools whose name matches
  // the pattern. This is the pragmatic "tool family" fix — the
  // classifier's exact picks are advisory, the intent-wide family is the
  // real selection. Text-only intents (wanted=[] AND no tool_pattern) still
  // get no tools.
  const pattern = manifest.tool_pattern;
  if (wanted.length === 0 && !pattern) return [];
  const allowed = new Set(wanted);
  return allTools.filter(t => {
    const name = t.function?.name || t.name;
    if (!name) return false;
    if (allowed.has(name)) return true;
    if (pattern && pattern.test(name)) return true;
    return false;
  });
}

/** Build a short hint block to inject into the system message. */
export function formatIntentHint(manifest) {
  if (!manifest || manifest.fallback) return "";
  const isTextOnly = Array.isArray(manifest.tools) && manifest.tools.length === 0;
  const toolDesc = isTextOnly
    ? "none (respond with text only)"
    : manifest.tools.join(", ");

  const parts = [
    `Classified as: ${manifest.intent}`,
    `User wants: ${manifest.user_wants || "(see message)"}`,
    `Available tools: ${toolDesc}`,
    `Max steps: ${manifest.max_steps}`,
    `Expected output: ${manifest.expected}`,
  ];

  if (isTextOnly) {
    // Override the default Execution Flow (Intent/Action/Evaluate cycle with EXPECT markers):
    // for text-only intents there is no tool call to evaluate — the model must answer directly.
    parts.push("");
    parts.push("IMPORTANT: This is a text-only request. Do NOT write 'EXPECT: ...' or describe what you plan to do.");
    parts.push("Answer the user directly with the final result in one message.");
  } else {
    // For tool-backed intents the model has historically sometimes shortcircuited
    // to a text response without ever calling a tool (e.g. classifier picks
    // file_write for "translate and save", but Gemini Flash just outputs the
    // translation in chat and forgets the file). Force the model to use a tool.
    parts.push("");
    parts.push("IMPORTANT: This task requires you to call at least one of the available tools above.");
    parts.push("Do NOT respond with text only and consider the task done — you MUST produce a tool_call to fulfil the request (e.g. write_file to save a result, run_command to execute, etc).");
  }

  return `\n\n<intent>\n${parts.join("\n")}\n</intent>`;
}
