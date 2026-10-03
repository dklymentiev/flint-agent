import "dotenv/config";
import path from "node:path";
import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getProvider } from "./providers/registry.js";
import { getActiveProvider, getLastModel } from "./providers/state.js";
import { getKey, hasKey } from "./providers/keys.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");

const DEFAULT_PORT = 3000;

// OpenRouter provider preference for the main model, from the environment
// OPENROUTER_PROVIDER_ONLY / _IGNORE / _ORDER are comma lists of provider slugs
// (as on the model's endpoints page, e.g. "xiaomi,atlas-cloud"), _SORT is
// price | throughput | latency. The same four keys other agents take as
// provider_routing, so both agents can be pinned alike. null when none is set.
function openrouterProviderFromEnv() {
  const list = (v) => (v || "").split(",").map((s) => s.trim()).filter(Boolean);
  const pref = {};
  const only = list(process.env.OPENROUTER_PROVIDER_ONLY);
  const ignore = list(process.env.OPENROUTER_PROVIDER_IGNORE);
  const order = list(process.env.OPENROUTER_PROVIDER_ORDER);
  const sort = (process.env.OPENROUTER_PROVIDER_SORT || "").trim();
  if (only.length) pref.only = only;
  if (ignore.length) pref.ignore = ignore;
  if (order.length) pref.order = order;
  if (sort) pref.sort = sort;
  return Object.keys(pref).length ? pref : null;
}

function getArgValue(name) {
  const idx = process.argv.indexOf(name);
  if (idx !== -1 && process.argv[idx + 1]) {
    return process.argv[idx + 1];
  }
  return null;
}

// Resolve provider — CLI > env > persisted state > default
const cliProvider = getArgValue("--provider");
const envProvider = process.env.FLINT_PROVIDER;
const initialProviderId = cliProvider || envProvider || getActiveProvider() || "openrouter";

const provider = getProvider(initialProviderId) || getProvider("openrouter");

// Resolve model — CLI > env > last used for provider > provider default
const cliModel = getArgValue("--model");
const envModel = process.env.OPENROUTER_MODEL;
const lastModel = getLastModel(provider.id);
const initialModel = cliModel || envModel || lastModel || provider.defaultModel;

export const config = {
  // Provider-aware fields (mutable — updated when provider switches)
  provider: provider.id,
  model: initialModel,

  // API key — resolved lazily; falls back to env vars for backward compat
  _apiKeyCache: null,
  _apiKeyCacheProvider: null,

  get apiKey() {
    // Sync getter — returns cached key or env fallback
    // Call config.resolveApiKey at startup for async encrypted key resolution
    if (this._apiKeyCache && this._apiKeyCacheProvider === this.provider) {
      return this._apiKeyCache;
    }
    // Env var fallbacks for backward compat
    if (this.provider === "openrouter") return process.env.OPENROUTER_API_KEY || null;
    if (this.provider === "openai") return process.env.OPENAI_API_KEY || null;
    if (this.provider === "anthropic") return process.env.ANTHROPIC_API_KEY || null;
    return null;
  },

  set apiKey(val) {
    this._apiKeyCache = val;
    this._apiKeyCacheProvider = this.provider;
  },

  // Resolve API key from encrypted storage (async — call at startup)
  async resolveApiKey() {
    const key = await getKey(this.provider);
    if (key) {
      this._apiKeyCache = key;
      this._apiKeyCacheProvider = this.provider;
      return key;
    }
    // Fallback to env vars
    return this.apiKey;
  },

  get apiUrl() {
    const p = getProvider(this.provider);
    if (!p) return "https://openrouter.ai/api/v1/chat/completions";
    if (p.format === "anthropic") return `${p.baseUrl}/messages`;
    if (p.ollamaCompat) return `${p.baseUrl}/v1/chat/completions`;
    return `${p.baseUrl}/chat/completions`;
  },

  port: parseInt(getArgValue("--port") || (process.env.AGENT_PARENT_PORT ? process.env.AGENT_PORT : null) || DEFAULT_PORT, 10),
  // Whether somebody named that port on purpose. When they did, the server
  // binds it or fails, instead of quietly scanning upwards: a bench subject
  // that lands on a different port than the harness was told about measures
  // whatever else is listening. On 2026-09-21 two runs were asked for 3001 and
  // reported themselves on 3002 and 3003.
  portExplicit: !!getArgValue("--port"),
  memoryUrl: process.env.MEMORY_API_URL ? process.env.MEMORY_API_URL.replace(/\/+$/, "") : null,
  // 2048 starved reasoning models: on the 2026-09-22 auto-budget run the
  // final turn and the summary both came back with completion=2048 and zero
  // characters of content, the whole allowance spent on thinking.
  maxResponseTokens: parseInt(process.env.AGENT_MAX_RESPONSE_TOKENS || "16384", 10),
  maxDisplayLines: parseInt(process.env.AGENT_MAX_LINES || "1000", 10),
  maxResponseLines: parseInt(process.env.AGENT_MAX_RESPONSE_LINES || "500", 10),
  mcpServers: process.env.MCP_SERVERS || null,
  // Steps per turn. 50 cut real work short: on 2026-09-29 the open-source
  // self-audit hit it 8 times in one afternoon, while everyday tasks need a
  // median of 3 and at most 15 (71-task run). The ceiling is a runaway guard,
  // not a budget; money is capped by AGENT_MAX_COST.
  maxIterations: parseInt(process.env.AGENT_MAX_ITERATIONS || "150", 10),
  maxCostPerAction: parseFloat(process.env.AGENT_MAX_COST || "0"),
  sessionBudget: parseFloat(process.env.AGENT_SESSION_BUDGET || "0"), // session-level $ limit (0=unlimited)
  // Unset means "derive from the model's window", see compressThreshold in
  // agent/compression.js. A fixed 50000 with an eager pass at half of it
  // rewrote every read file into a one-line summary at about 25k tokens, and
  // the agent spent the rest of the turn reading the same files again.
  compressAfterTokens: process.env.COMPRESS_AFTER_TOKENS ? parseInt(process.env.COMPRESS_AFTER_TOKENS, 10) : null,
  headless: false,
  // Escape hatch back to the old fallback that handed the model every live tool.
  // See fallbackManifest in intent.js for the numbers that closed it.
  fallbackAllTools: process.env.FLINT_FALLBACK_ALL_TOOLS === "1",
  apiAutoApprove: process.env.AGENT_API_AUTO_APPROVE !== "0", // auto-approve tools for authenticated API callers (default: true)
  // Whether the agent may install or reload a plugin without asking. "ask"
  // unless FLINT_PLUGIN_INSTALL=allow; any other value asks too. A plugin is
  // code with the agent's rights, so it is asked even when apiAutoApprove
  // opens everything else, and a run with no operator is refused.
  pluginInstall: process.env.FLINT_PLUGIN_INSTALL === "allow" ? "allow" : "ask",
  openrouterProvider: openrouterProviderFromEnv(),
  // The self-verification gate: after "done" on a turn that changed
  // files and ran nothing, one more round asks the model to show the change
  // works. Built for weaker models (Gemini Flash) that stop before checking.
  // On mimo it cost a round in 34 of 43 benchmark tasks with no gain in
  // passes.
  //
  // Off by default: the models Flint runs on now check on
  // their own; FLINT_SELF_VERIFY=on brings it back for a weaker one.
  selfVerify: process.env.FLINT_SELF_VERIFY === "on" ? "on" : "off",
  autoMaxIterations: parseInt(process.env.AGENT_AUTO_MAX_ITERATIONS || "50", 10),
  autoMaxCost: parseFloat(process.env.AGENT_AUTO_MAX_COST || "0.50"),
  // Where this instance keeps what it writes. FLINT_DATA_DIR moves it off the
  // shared defaults, which is what a bench subject needs: on 2026-09-21 the
  // readiness subject and the operator's own live agent wrote into the same
  // sessions/ directory and the same memory database, so a measured run
  // carried another process's turns and another process's facts, and a unit
  // test that clears the facts table raced a live agent writing to it.
  sessionsDir: process.env.FLINT_DATA_DIR
    ? path.join(path.resolve(process.env.FLINT_DATA_DIR), "sessions")
    : process.env.AGENT_PARENT_PORT
    ? path.join(PROJECT_ROOT, "sessions", "children")
    : path.join(PROJECT_ROOT, "sessions"),
  projectRoot: PROJECT_ROOT,
  // Where .permissions.json lives — the operator's own saved permissions,
  // onboarding answer, per-file "[a]lways" approvals.
  //
  // Split out from projectRoot because the two answer different questions.
  // projectRoot is "where the code and the resources are", and moving it
  // changes what a run reads: profiles.js, memory/store.js, bus/plugins.js all
  // resolve their directories from it at module load, so a test run with a
  // redirected projectRoot would load no profiles and no memories, and pass
  // against an empty sandbox rather than the real thing. That was tried and
  // reverted for exactly this reason.
  //
  // The one thing that genuinely must not be shared is the file a run WRITES.
  // A test writing config.projectRoot/.permissions.json overwrote the
  // developer's own saved permissions on every suite run, and because the file
  // is in .gitignore the overwrite left `git status` clean — silent damage that
  // only a container diff of the work tree ever noticed.
  //
  // Production is unchanged: unset means exactly the path it has always meant.
  // A test run points it at a temp dir, so the bytes land there and the
  // checkout is left byte-for-byte as it was found.
  permissionsFile: process.env.FLINT_TEST_PERMISSIONS_FILE
    ? path.resolve(process.env.FLINT_TEST_PERMISSIONS_FILE)
    : path.join(PROJECT_ROOT, ".permissions.json"),
  // Working directory for agent file operations (created per session)
  // If set, relative paths in file tools resolve from here instead of cwd
  // If empty, defaults to sessions/<sessionId>/workspace/
  workdirBase: process.env.AGENT_WORKDIR || "",
  // Filesystem sandbox: comma-separated list of allowed directories
  // If empty/null — unrestricted access
  // Example: AGENT_ALLOWED_PATHS=C:\Projects,C:\tmp,D:\data
  allowedPaths: (process.env.AGENT_ALLOWED_PATHS || "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => path.resolve(p)),
  maxChildAgents: parseInt(process.env.AGENT_MAX_CHILDREN || "5", 10),
  childIdleTimeout: parseInt(process.env.AGENT_CHILD_IDLE_TIMEOUT || "60", 10), // seconds
  childCleanupDelay: parseInt(process.env.AGENT_CHILD_CLEANUP_DELAY || "30000", 10), // ms before removing stopped agent from registry
  shell: process.env.AGENT_SHELL || (() => {
    if (process.platform !== "win32") return "/bin/bash";
    // Prefer Git Bash over WSL bash on Windows (check standard install paths)
    const candidates = [
      process.env.ProgramFiles && `${process.env.ProgramFiles}\\Git\\usr\\bin\\bash.exe`,
      "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
    ].filter(Boolean);
    for (const p of candidates) { try { statSync(p); return p; } catch {} }
    return "bash";
  })(),
  maxBatchFiles: parseInt(process.env.AGENT_MAX_BATCH_FILES || "20", 10),
  budgetWarningThresholds: (process.env.AGENT_BUDGET_WARNINGS || "0.5,0.8").split(",").map(Number),
  securityPolicy: process.env.AGENT_SECURITY_POLICY || "normal",
  extractionModel: process.env.EXTRACTION_MODEL || "google/gemini-2.0-flash-001",
  compressThreshold: parseInt(process.env.COMPRESS_THRESHOLD || "500", 10),
  maxContextChars: parseInt(process.env.MAX_CONTEXT_CHARS || "20000", 10),
  maxPromptTokens: parseInt(process.env.MAX_PROMPT_TOKENS || "100000", 10),
  // Classifier model, from INTENT_MODEL. Optional: when it is not set the
  // classifier is off and every turn gets the built-in tools (the same path
  // as FLINT_NO_CLASSIFIER=1). Owner, 2026-10-01: a missing classifier model
  // must not stop Flint from starting. No default model is guessed.
  //
  // Measured on 2026-04-21 (.env.example has the full ranking; short list)
  // openai/gpt-5.4-mini 4/4 1.5-2s $0.75/M best value
  // x-ai/grok-4.20 4/4 1.0-1.3s $2/M fastest
  // anthropic/claude-sonnet-4.6 4/4 2.5-3s $3/M
  // qwen/qwen3.5-flash-02-23 4/4 4-15s $0.07/M cheapest, slow
  intentModel: (process.env.INTENT_MODEL || "").trim() || null,
};

// Log config at boot (logger imports dotenv too, so it's ready)
import { createLogger } from "./logging/logger.js";
const _configLog = createLogger("config");
_configLog.info("Config loaded", { port: config.port, model: config.model, provider: config.provider, sessionsDir: config.sessionsDir });

// Check if any key is available — don't exit, defer to first-run wizard
function hasAnyKey() {
  // Check encrypted storage
  if (hasKey(config.provider)) return true;
  // Check env vars
  if (process.env.OPENROUTER_API_KEY) return true;
  if (process.env.OPENAI_API_KEY) return true;
  if (process.env.ANTHROPIC_API_KEY) return true;
  // Ollama doesn't need a key
  if (config.provider === "ollama") return true;
  return false;
}

// Export for first-run wizard check
export const needsFirstRunSetup = !hasAnyKey();
