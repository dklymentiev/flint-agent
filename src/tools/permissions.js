// Permissions + Hooks system — wraps executeTool with permission checks and hooks

import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { executeTool, getDefinitions } from "./registry.js";
import { mcpServerOf } from "./mcp-tool-servers.js";

// Tool-name auto-repair at the entry point so permission checks use the corrected name.
// Levenshtein distance <= 2, unambiguous closest match.
function _levDistance(a, b) {
  const m = a.length, n = b.length;
  if (a === b) return 0;
  if (!m) return n;
  if (!n) return m;
  const dp = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0]; dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev : Math.min(prev, dp[j], dp[j - 1]) + 1;
      prev = tmp;
    }
  }
  return dp[n];
}
function _repairToolName(name) {
  try {
    const names = getDefinitions().map(t => t.function?.name).filter(Boolean);
    if (names.includes(name)) return name;
    const scored = names.map(n => ({ n, d: _levDistance(name, n) })).filter(x => x.d <= 2).sort((a, b) => a.d - b.d);
    if (!scored.length) return null;
    if (scored.length === 1 || scored[0].d < scored[1].d) return scored[0].n;
    return null;
  } catch { return null; }
}
import { config } from "../config.js";
import { grantCommandApproval } from "./command-approvals.js";
import { LEVELS, levelOptions, parseLevelAnswer, SECRET_FILE_PATTERNS, toolPermissionAtLevel, DEFAULT_ONBOARDING_LEVEL } from "../security/policies.js";

// ── Security level, from the one onboarding question ──

/**
 * Which tools are reads, and so do not prompt.
 *
 * Reading is what the agent is for. A turn that reads twenty files asked twenty
 * questions, and every one of them was "may I read the file you just asked me
 * to read" — an operator who answers yes to that once has learned that yes is
 * the only answer, and a prompt that has stopped being a decision is worse than
 * no prompt at all, because it still costs the time to read it.
 *
 * The exception is in `isSecretFile` below, and it is the whole reason the
 * exception is safe to have.
 */
export function isReadTool(name) {
  return READ_TOOLS.has(name);
}

const READ_TOOLS = new Set([
  "read_file", "list_directory", "glob", "search_in_files",
  "web_fetch", "web_search", "view_image",
  "think", "check_balance", "check_inbox", "list_models",
  "memory_search", "memory_get",
  // The plan-navigation and MCP-status tools, which are reads that arrived
  // after the list above was written: a tool with no entry in
  // DEFAULT_PERMISSIONS falls through getPermission to "confirm", so
  // `task_stats` — a dashboard query over the operator's own task database —
  // was stopping every turn to ask a question nobody could have an opinion
  // about.
  //
  // Here rather than only in the table below, because these are reads and a
  // read does not prompt whatever the table says. They take no file argument,
  // so the secret carve-out has nothing to apply to.
  //
  // `today` is deliberately NOT here: it reads when called with no arguments
  // and writes (marks tasks for today) when called with task_ids. It is
  // allowed in the table beside its sibling task tools instead, where a
  // name-only set cannot express the difference.
  "task_stats", "list_goals", "focus_goal", "wait_tasks", "list_mcp_servers",
  // A read of the skill/memory store, same as memory_get above it. It took no
  // part in that pair until this commit, and asked on every call.
  "memory_expand",
]);

/**
 * Is this a file whose contents are not the agent's business without asking?
 *
 * A read exception is only safe because of this. `.env`, an SSH key, a
 * credentials file — these are how an agent walks off with the operator's
 * tokens, and a rule that never asks about them is not a safer rule, it is a
 * rule that has stopped looking.
 *
 * Matched on what the file *is*, not where it lives: a secret is a secret
 * wherever it is kept, and anchoring on the project root would exempt a copy in
 * a subdirectory, which is the copy somebody actually pasted into a bug report.
 */
export function isSecretFile(filePath) {
  if (!filePath) return false;
  const p = String(filePath);
  return SECRET_FILE_PATTERNS.some((re) => re.test(p));
}

const ONBOARDING_KEY = "onboardingAnswer";

/**
 * Has the operator been asked, and what did they answer?
 *
 * Two pieces of state rather than one, because "answered" and "answered
 * something" are different. If a cancelled question counted as an answer, Esc
 * on the first launch would skip the question forever and leave the user at a
 * posture they never chose and cannot see.
 */
export function getOnboardingState() {
  return { asked: Object.prototype.hasOwnProperty.call(sessionOverrides, ONBOARDING_KEY), answer: getOnboardingAnswer() };
}

/**
 * Ask the one onboarding question, if it has not been answered yet.
 *
 * Without this the question in the spec does not exist: `saveOnboardingAnswer`
 * had no caller outside tests, so a fresh Flint home was never asked, and
 * nothing was there to skip on the second start either.
 *
 * @param {object} opts
 * @param {(question: string) => Promise<string|null>} opts.confirm — the prompt
 * @returns {Promise<boolean>} true if the question was asked now
 */
export async function askOnboardingIfNeeded({ confirm } = {}) {
  if (getOnboardingState().asked) return false;
  if (typeof confirm !== "function") {
    throw new Error("askOnboardingIfNeeded needs a confirm function; there is nothing to ask with");
  }
  // The prompt and the accepted answers are built from one list, so they cannot
  // disagree. They did: the prompt said "pick s, n or p" and only "safe"/"normal"/
  // "permissive" were recorded, so an operator who typed `n` — exactly as told —
  // was silently not recorded and the question came back on every start, which is
  // the opposite of "asked once". Every test before that fed full words,
  // so the suite agreed with itself while the operator got nothing.
  const question = levelOptions()
    .map((o) => `[${o.key}]${o.level.slice(1)}  (${o.description})`)
    .join("   ");
  const answer = await confirm(
    `How careful should Flint be?\n${question}\n  — pick ${levelOptions().map((o) => o.key).join(", ")}`,
  );
  const level = parseLevelAnswer(answer);
  // A cancelled or unreadable answer is not an answer. Recording it would
  // permanently skip the question, which is how a user ends up at a posture
  // nobody chose.
  if (!level) return true;
  saveOnboardingAnswer(level);
  return true;
}

/**
 * The level the operator chose, or null if nobody has been asked yet.
 *
 * @returns {"safe"|"normal"|"permissive"|null}
 */
export function getOnboardingAnswer() {
  return sessionOverrides[ONBOARDING_KEY] ?? null;
}

/**
 * Record the answer to the one onboarding question, and persist it.
 *
 * Persisted, because a question that comes back on every launch is a question
 * nobody learns to answer well. A value that is not one of the three levels is
 * refused rather than stored: a saved answer nobody chose is worse than no
 * answer, because it looks like a choice was made.
 */
export function saveOnboardingAnswer(level) {
  if (!LEVELS.includes(level)) {
    throw new Error(
      `Unknown security level: ${level}. Expected one of: ${LEVELS.join(", ")}`,
    );
  }
  sessionOverrides[ONBOARDING_KEY] = level;
  saveOverridesToDisk();
}

/**
 * Clear everything a test set up, so one test's permissions cannot decide
 * another's. Not exported for the app — only for tests.
 */
export function resetPermissionState() {
  for (const k of Object.keys(sessionOverrides)) delete sessionOverrides[k];
  Object.assign(sessionOverrides, _loaded.levels);
  for (const key of Object.keys(approvedPaths)) delete approvedPaths[key];
  _globalPermission = null;
  _unattended = false;
}


// ── Default permission levels ──

const DEFAULT_PERMISSIONS = {
  // allow — execute without confirmation
  read_file: "allow",
  list_directory: "allow",
  glob: "allow",
  search_in_files: "allow",
  view_image: "allow",
  think: "allow",
  check_balance: "allow",
  check_inbox: "allow",
  list_models: "allow",
  add_task: "allow",
  list_processes: "allow",
  peek_process: "allow",
  web_fetch: "allow",
  web_search: "allow",
  memory_write: "allow",
  memory_search: "allow",
  memory_get: "allow",
  memory_delete: "allow",

  // Skills — the agent's own persistent procedures, stored as markdown under
  // ~/.flint/memory/skills/. Same class as the memory tools above and given
  // the same answer; they had no entry at all, so skill_add — a tool the
  // agent calls whenever it learns a repeatable procedure — stopped the turn
  // to ask the operator to approve remembering something.
  skill_add: "allow",
  skill_update: "allow",
  skill_remove: "allow",
  memory_expand: "allow",

  list_agents: "allow",

  // screenbox — screenshot is safe, interactive tools need confirmation
  desktop_screenshot: "allow",
  desktop_look: "allow",
  desktop_resume: "allow",
  desktop_click: "confirm",
  desktop_type: "confirm",
  desktop_key: "confirm",
  desktop_scroll: "confirm",
  desktop_chrome: "confirm",

  // mesh memory — all safe
  mesh_search: "allow",
  mesh_add: "allow",
  mesh_recent: "allow",

  // Google Workspace (MCP) — read=allow, write=confirm
  search_gmail_messages: "allow",
  get_gmail_message_content: "allow",
  get_gmail_messages_content_batch: "allow",
  get_gmail_thread_content: "allow",
  get_gmail_threads_content_batch: "allow",
  list_gmail_labels: "allow",
  send_gmail_message: "confirm",
  draft_gmail_message: "confirm",
  modify_gmail_message_labels: "confirm",
  batch_modify_gmail_message_labels: "confirm",
  manage_gmail_label: "confirm",

  // datasets — safe (read-only navigation)
  show_dataset: "allow",

  // task planning — all safe
  create_plan: "allow",
  update_task: "allow",
  list_tasks: "allow",
  add_task_note: "allow",
  link_task_file: "allow",

  // Plan navigation. These arrived after the list above and had no entry, so
  // getPermission fell through to "confirm" and the agent stopped every turn
  // to ask about reading the operator's own task database. See READ_TOOLS for
  // why `today` is in the table but not in the set.
  task_stats: "allow",
  list_goals: "allow",
  focus_goal: "allow",
  wait_tasks: "allow",
  today: "allow",
  create_subtask: "allow",

  // MCP plumbing. reconnect_mcp asks, deliberately: it rebuilds a session on a
  // server that is the operator's own machine, and a tool that has been failing
  // with "fetch failed" is a tool whose name has just come out of an error
  // message. It stays a question.
  list_mcp_servers: "allow",
  // Loads tool definitions into the turn; runs nothing itself.
  tool_search: "allow",
  // Read the session's own swap; nothing leaves the machine.
  swap_list: "allow",
  swap_read: "allow",
  reconnect_mcp: "confirm",


  // provider switching — safe (doesn't cost money or change data)
  switch_model: "allow",
  switch_provider: "allow",
  list_providers: "allow",

  // confirm — ask user before executing
  spawn_agent: "confirm",
  ask_agent: "confirm",
  write_file: "confirm",
  edit_file: "confirm",
  delete_file: "confirm",
  create_directory: "confirm",
  copy_file: "confirm",
  move_file: "confirm",
  run_command: "confirm",
  run_background_command: "confirm",
  kill_process: "confirm",
  restart_agent: "confirm",
  clear_context: "confirm",
  // A plugin is code that runs with the agent's rights.
  install_plugin: "confirm",
  reload_plugins: "confirm",
};

// ── Persistence ──

// config.permissionsFile, not projectRoot + the name. Under a test run the
// whole point is that this is somewhere else, and rebuilding the path from
// projectRoot here would put it back in the developer's checkout. Reads
// defensively: several integration tests replace the config object wholesale
// with only the keys their subject reads, so a missing key must fall back to
// the historical path rather than be undefined.
const PERMISSIONS_FILE = config.permissionsFile
  || path.join(config.projectRoot || process.cwd(), ".permissions.json");

// Reserved key inside .permissions.json. Everything else in that file is a
// tool name -> level; this one holds per-file approvals, "<tool>:<abs path>".
// One file, because the operator should have one place to look at what they
// have granted.
const APPROVED_PATHS_KEY = "_approvedPaths";

function loadPermissionsFile() {
  try {
    if (existsSync(PERMISSIONS_FILE)) {
      const raw = JSON.parse(readFileSync(PERMISSIONS_FILE, "utf-8"));
      const { [APPROVED_PATHS_KEY]: paths, ...levels } = raw;
      return { levels, paths: paths && typeof paths === "object" ? paths : {} };
    }
  } catch {}
  return { levels: {}, paths: {} };
}

function saveOverridesToDisk() {
  try {
    const out = { ...sessionOverrides };
    if (Object.keys(approvedPaths).length) out[APPROVED_PATHS_KEY] = approvedPaths;
    writeFileSync(PERMISSIONS_FILE, JSON.stringify(out, null, 2) + "\n");
  } catch {}
}

// Sub-second windows exist only in tests, but rounding them to "0s" makes the
// refusal read like a bug in the tool rather than an unanswered prompt.
function formatWindow(ms) {
  return ms < 1000 ? `${ms}ms` : `${Math.round(ms / 1000)}s`;
}

// ── Security log ──

function logSecurity(action, toolName, args, reason) {
  try {
    const dir = config.sessionsDir;
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "security.log");
    const ts = new Date().toISOString();
    const argsStr = args && typeof args === "object"
      ? Object.entries(args).map(([k, v]) => {
          const s = typeof v === "string" && v.length > 100 ? v.slice(0, 100) + "..." : String(v);
          return `${k}=${s}`;
        }).join(" ")
      : "";
    // pid, because several instances share this file: the interactive one the
    // owner keeps open, plus whatever a benchmark or a test stand starts. Without
    // it a denial cannot be attributed to a run, and on 2026-09-20 that led to a
    // readiness timeout being blamed on the wrong instance.
    appendFileSync(file, `[${ts}] [pid ${process.pid}] ${action} ${toolName}(${argsStr})${reason ? " | " + reason : ""}\n`);
  } catch {}
}

// ── State ──

const _loaded = loadPermissionsFile();
const sessionOverrides = _loaded.levels;
// "<tool>:<resolved path>" -> true. A hook that forces confirmation can offer
// a key; answering "always" records THAT key rather than opening the tool up
// everywhere. Without this there was nowhere to put the operator's decision,
// so it was written as a tool-wide "allow" that the forced-confirm branch
// never consulted, and the same prompt came back forever.
const approvedPaths = _loaded.paths;
const beforeHooks = [];       // (name, args) → { allow } | { deny, reason } | { confirm, reason?, key? } | null
const afterHooks = [];        // (name, args, result) → transformedResult | null
let confirmFn = null;         // injected via initPermissions
// Auto-deny window when the user does not respond to an approval prompt.
// Was 30s and caused a retry-storm: operator glances at another terminal
// for half a minute, the prompt times out, the agent retries, more prompts
// pile up, eventually everything fails. 600s gives a realistic "human is
// not at keyboard" window before giving up. Paired with a system.md rule
// that forbids retrying after a denial/timeout.
let confirmTimeoutMs = 600000; // 10 minutes
let _globalPermission = null; // set by bulkSetPermission — overrides everything
// True while the turn came in over the bus (api/agent/autonomous) and there is
// nobody at the keyboard. Waiting out confirmTimeoutMs then would buy nothing:
// the answer can only ever be "timeout", and the whole time the bus is serial,
// so every queued message sits behind the wait. Raising the window from 30s to
// 600s for the operator's sake made that ten times worse for unattended runs.
let _unattended = false;

// ── API ──

export function initPermissions({ confirm, timeout }) {
  confirmFn = confirm;
  if (timeout != null) confirmTimeoutMs = timeout;
}

/**
 * The key a whole-server rule is stored under in .permissions.json. The colon
 * keeps it from ever being a tool's name.
 */
export function mcpServerKey(server) {
  return `mcp_server:${server}`;
}

export function getPermission(name) {
  if (_globalPermission) return _globalPermission;
  if (sessionOverrides[name]) return sessionOverrides[name];
  // One answer for a whole MCP server (owner, 2026-10-03): "always" on one
  // tool left every other tool of the same server asking, about fifty
  // prompts for five servers. A rule for the tool itself is checked first,
  // so /deny or /confirm on one tool still holds.
  const server = mcpServerOf(name);
  if (server && sessionOverrides[mcpServerKey(server)]) return sessionOverrides[mcpServerKey(server)];
  // The chosen care level relaxes a default of "confirm" (see policies.js).
  const level = getOnboardingAnswer() || DEFAULT_ONBOARDING_LEVEL;
  return toolPermissionAtLevel(level, name, DEFAULT_PERMISSIONS[name] || "confirm");
}

export function setPermission(name, level) {
  sessionOverrides[name] = level;
  saveOverridesToDisk();
}

export function getPermissionMap() {
  const map = {};
  const allNames = new Set([
    ...Object.keys(DEFAULT_PERMISSIONS),
    ...Object.keys(sessionOverrides),
  ]);
  for (const name of allNames) {
    map[name] = getPermission(name);
  }
  return map;
}

export function addBeforeHook(fn) {
  beforeHooks.push(fn);
}

export function addAfterHook(fn) {
  afterHooks.push(fn);
}

export function resetSessionOverrides() {
  // The care level lives in the same map but is not a tool override: resetting
  // permissions used to erase it, and the onboarding question came back.
  for (const key of Object.keys(sessionOverrides)) {
    if (key === ONBOARDING_KEY) continue;
    delete sessionOverrides[key];
  }
  for (const key of Object.keys(approvedPaths)) {
    delete approvedPaths[key];
  }
  // /allow-all and /deny-all too. They used to end with the process; since a
  // restart of the same session keeps them (restart.js), this is the way out.
  _globalPermission = null;
  saveOverridesToDisk();
}

/** Per-file approvals, for /permissions and for tests. */
export function getApprovedPaths() {
  return { ...approvedPaths };
}

export function revokeApprovedPath(key) {
  if (!(key in approvedPaths)) return false;
  delete approvedPaths[key];
  saveOverridesToDisk();
  return true;
}

/** The window the operator actually gets, so the UI can stop guessing. */
export function getConfirmTimeoutMs() {
  return confirmTimeoutMs;
}

/** Mark the current turn as having no operator behind it. Set by the drain loop. */
export function setUnattended(v) {
  _unattended = !!v;
}

export function isUnattended() {
  return _unattended;
}

export function bulkSetPermission(level) {
  // SEC-02: YOLO mode is session-only — never persist to disk.
  // A prompt-injected agent must not be able to self-escalate permanently.
  _globalPermission = level;
}

/**
 * The blanket level set by /allow-all or /deny-all, or null. Read by the
 * restart (restart.js), which hands it to the launcher so that a restart of
 * the same session does not silently drop it.
 */
export function getBulkPermission() {
  return _globalPermission || null;
}

const PLUGIN_LOAD_TOOLS = new Set(["install_plugin", "reload_plugins"]);

// ── Main wrapper ──

export async function executeToolWithPermissions(name, args) {
  // 0. Auto-repair: if tool name is slightly off (typo, variant), map to closest real name.
  const repaired = _repairToolName(name);
  if (repaired && repaired !== name) {
    console.error(`[tool-repair] '${name}' -> '${repaired}'`);
    name = repaired;
  }
  // 1. Run before hooks — first non-null verdict wins
  let hookAllowed = false;
  let forceConfirm = false;
  let confirmReason = null;   // why this particular call needs an answer
  let confirmKey = null;      // what "always" would remember, if anything
  // A hook already spoke for this call. Its key, its reason and its answer are
  // better informed than anything the read fallback below can produce, and its
  // "already approved" verdict deliberately sets no forceConfirm — so without
  // this flag the fallback would ask a second time about a call a hook had
  // already settled, which is how granting "[a]lways" appeared to do nothing.
  let hookDecided = false;
  for (const hook of beforeHooks) {
    const verdict = await hook(name, args);
    if (verdict) {
      if (verdict.deny) {
        logSecurity("DENIED_HOOK", name, args, verdict.reason);
        return { result: `Denied by hook: ${verdict.reason || "no reason"}`, denied: true, denyKey: verdict.denyKey || null };
      }
      if (verdict.allow) { hookAllowed = true; break; }
      if (verdict.confirm) {
        // An answer already given for this exact file is an answer. Asking
        // again is how you train an operator to stop reading the prompt.
        if (verdict.key && approvedPaths[verdict.key]) {
          logSecurity("ALLOWED_PATH", name, args, `previously approved: ${verdict.key}`);
          hookDecided = true;
          break;
        }
        forceConfirm = true;                       // force confirm even when permission is "allow"
        confirmReason = verdict.reason || null;
        confirmKey = verdict.key || null;
        hookDecided = true;
        break;
      }
    }
  }

  // 1b. Installing or loading a plugin runs code nobody reviewed with the
  // agent's rights. Unless config says pluginInstall "allow", it is asked
  // every time, over a hook's allow and over the API's auto-approve alike,
  // and a run with no operator is refused. "Always" is remembered under its
  // own key, or the prompt would come back forever.
  if (PLUGIN_LOAD_TOOLS.has(name) && config.pluginInstall !== "allow") {
    const key = `${name}:plugin`;
    if (!approvedPaths[key]) {
      forceConfirm = true;
      confirmReason = "a plugin is code that runs with the agent's rights (pluginInstall is \"ask\"; FLINT_PLUGIN_INSTALL=allow skips this)";
      confirmKey = key;
    }
  }

  // 2. Check permission level (skip if hook already allowed)
  //
  // A read is not a question, with one exception.
  //
  // Reading is what the agent is for. A turn that reads twenty files asked
  // twenty questions, every one of them "may I read the file you just asked me
  // to read" — and an operator who answers yes to that once has learned that
  // yes is the only answer. A prompt that has stopped being a decision costs
  // the time to read it and buys nothing.
  //
  // The exception is what makes the rule safe rather than reckless: .env, an
  // SSH key, a credentials file still ask, at every level including
  // permissive, because that is how an agent walks off with the operator's
  // tokens. A hook that already allowed this call wins — an explicit answer
  // beats a default.
  let level = hookAllowed ? "allow" : getPermission(name);
  if (!hookAllowed && isReadTool(name) && level !== "deny") {
    const fileish = args?.path || args?.file_path || args?.file;
    const secret = fileish ? isSecretFile(fileish) : false;
    if (!secret) {
      logSecurity("ALLOWED_READ", name, args, "reads do not prompt");
      level = "allow";
    } else if (!forceConfirm && !hookDecided) {
      // Named in the prompt, because "may I read this file" and "may I read
      // .env" are different questions and the operator is entitled to know
      // which one they are answering.
      //
      // Guarded on `!forceConfirm` because a hook may already have forced a
      // confirm for this very call, with a better key and a better reason than
      // anything written here. Forcing a second one asked the operator the
      // same question twice, and the `[a]lways` answer was then stored against
      // the hook's key while this branch went on asking under a different one —
      // so granting "always" appeared to do nothing.
      //
      // This branch is the fallback for when nothing upstream cared, which is
      // the ordinary case: no hook, and the agent is about to read a private
      // key on its own recognisance.
      forceConfirm = true;
      confirmReason = "this looks like a secret file (.env, a private key, credentials)";
      confirmKey = `${name}:secret:${fileish || ""}`;
    }
  }

  if (level === "deny") {
    logSecurity("DENIED_RULE", name, args, "tool denied by rule");
    return { result: `Tool "${name}" is denied.`, denied: true };
  }

  if ((level === "confirm" || forceConfirm) && confirmFn) {
    // What "always" will mean, in the operator's words, so the prompt does
    // not promise something wider than it grants.
    const scope = confirmKey
      ? `always allow ${name} for this path only`
      : `always allow ${name}`;

    // No operator, no point asking. Deny now instead of holding the bus for the
    // full window on a question that cannot be answered.
    if (_unattended) {
      logSecurity("DENIED_UNATTENDED", name, args, confirmReason || "approval required, no operator attached");
      return {
        result: `Tool "${name}" was not run: it needs the operator's approval and this run has no operator attached.` +
          (confirmReason ? ` Approval was required because ${confirmReason}.` : "") +
          ` Do not retry this call and do not look for another tool that does the same thing.` +
          ` Finish the turn and say plainly what you need approved.`,
        denied: true,
      };
    }

    // "All of this server" is offered only for the plain question about an MCP
    // tool. A prompt a hook or a guard forced is about one file or one
    // command, and its answer must stay that narrow.
    const serverChoice = !forceConfirm && !confirmKey ? mcpServerOf(name) : null;

    // Wrap confirm with timeout
    const answer = await Promise.race([
      confirmFn(name, args, { reason: confirmReason, scope, key: confirmKey, ...(serverChoice ? { server: serverChoice } : {}) }),
      new Promise((resolve) => setTimeout(() => resolve("timeout"), confirmTimeoutMs)),
    ]);

    if (answer === "server" && serverChoice) {
      sessionOverrides[mcpServerKey(serverChoice)] = "allow";
      saveOverridesToDisk();
    } else if (answer === "always") {
      if (confirmKey) {
        // Narrow on purpose: "always read this .env" is a decision a person
        // can mean; "always read every secret file" is not.
        approvedPaths[confirmKey] = true;
      } else if ((name === "run_command" || name === "run_background_command") && args?.command) {
        // A command prompt forced by the guard arrives with no key of its own,
        // so this branch used to fall through to `sessionOverrides[name] =
        // "allow"` — a tool-wide grant, in every project, for the rest of the
        // install, out of an answer about one command in one checkout. The
        // command guard asks anyway on its own patterns, so the operator was
        // prompted again on the next `git push` despite having answered
        // "always" — and the grant sat in the file widening the tool the whole
        // time. Recorded per project instead, which is the question that was
        // actually asked, and the guard reads it.
        grantCommandApproval({ cwd: args.cwd, command: args.command });
      } else {
        sessionOverrides[name] = "allow";
      }
      saveOverridesToDisk();
    } else if (answer === "timeout") {
      logSecurity("DENIED_TIMEOUT", name, args, `no response within ${confirmTimeoutMs / 1000}s`);
      // The model has to be told WHY, or it invents a reason and burns the
      // turn working around the wrong one: on 2026-09-19 it read a bare
      // "(timeout)" as "the file is too large" and spent ~15 of 26
      // iterations on subshell exports and agent restarts.
      return {
        result: `Tool "${name}" was not run: the operator did not answer the approval prompt within ${formatWindow(confirmTimeoutMs)}.` +
          (confirmReason ? ` Approval was required because ${confirmReason}.` : "") +
          ` Do not retry this call; ask the operator in plain words instead.`,
        denied: true,
      };
    } else if (answer !== "yes") {
      logSecurity("DENIED_USER", name, args, "user denied");
      return {
        result: `Tool "${name}" was denied by the operator.` +
          (confirmReason ? ` Approval was required because ${confirmReason}.` : "") +
          ` Do not retry this call or route around the denial; say what you needed and why.`,
        denied: true,
      };
    }
  }

  // 3. Execute tool
  let result = await executeTool(name, args);

  // 4. Run after hooks
  for (const hook of afterHooks) {
    const transformed = await hook(name, args, result);
    if (transformed != null) {
      result = transformed;
    }
  }

  return { result, denied: false };
}
