// Security policies — three profiles: strict / normal / permissive

import path from "node:path";
import os from "node:os";

const homeDir = os.homedir();

// Paths that must NEVER be written to regardless of policy
const CRITICAL_DENYLIST = [
  ".permissions.json",
  path.join(homeDir, ".ssh"),
  path.join(homeDir, ".gnupg"),
  path.join(homeDir, ".aws"),
  ...systemFolders(),
];

// The operating system's own folders (2026-10-02). Run as administrator,
// Flint wrote into C:\Windows\System32: only the OS had ever refused, and at
// the normal care level file writes do not ask. Writes only; reads are fine.
function systemFolders() {
  if (process.platform === "win32") {
    const env = process.env;
    return [
      env.SystemRoot || env.windir || "C:\\Windows",
      env.ProgramFiles || "C:\\Program Files",
      env["ProgramFiles(x86)"] || "C:\\Program Files (x86)",
    ];
  }
  return ["/etc", "/usr", "/bin", "/sbin", "/lib", "/lib64", "/boot", "/System"];
}

// Patterns that indicate secret content
const SECRET_PATTERNS = [
  /sk-[a-zA-Z0-9]{20,}/g,           // OpenAI / Stripe keys
  /ghp_[a-zA-Z0-9]{36,}/g,          // GitHub PATs
  /gho_[a-zA-Z0-9]{36,}/g,          // GitHub OAuth tokens
  /github_pat_[a-zA-Z0-9_]{22,}/g,  // GitHub fine-grained PATs
  /AKIA[A-Z0-9]{16}/g,              // AWS access key IDs
  /-----BEGIN\s+(RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g, // Private keys
  /eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g, // JWTs
  /xox[bpas]-[a-zA-Z0-9-]{10,}/g,   // Slack tokens
];

// Files that likely contain secrets
// ── Security levels ──
//
// Three explicit answers to "how careful should this be?", chosen once by an
// onboarding question and saved. Each level decides two things that used to be
// fixed by hardcoding: which tools prompt, and which dangerous-command patterns
// ask at all.
//
// The three are, in order of how much they trust a model to be careful:
//
//   safe        every tool that can change something asks; every dangerous
//               command pattern asks, including the merely unusual ones.
//   normal      the default. The destructive patterns ask; a command that is
//               merely unusual does not.
//   permissive  the agent has been told it may act without asking. Nothing
//               prompts except what is not a judgement about risk at all.
//
// A level has to change something, or it is a label. The count of dangerous
// patterns that ask is strictly decreasing across the three, which is what
// makes "I chose permissive" mean something.
//
// What none of the three does is unblock a hard block. HARD_BLOCKED_TOOLS
// stays blocked everywhere, deliberately: a level is a judgement about ordinary
// risk, and letting the most permissive answer remove the one protection that
// is not about risk would make "permissive" mean "no longer safe" — the level
// would be doing two contradictory jobs at once.

export const LEVELS = ["safe", "normal", "permissive"];

/**
 * The level in force until the onboarding question has been answered.
 *
 * Lives here rather than in security/index.js, which is where it was, because
 * two things now have to agree on it: the guard that applies the level, and
 * the first-run menu that marks one option as the current answer. A menu that
 * highlights `safe` while the guard runs `normal` until you answer is a lie
 * about what you are choosing, and the two constants would drift apart exactly
 * the way the prompt and the parser once did.
 *
 * Named, not inlined, because "normal" appears in this codebase for two
 * different reasons and only one of them is the default: the security
 * *profile* is also allowed to be "normal" (loadPolicy defaults to it).
 */
export const DEFAULT_ONBOARDING_LEVEL = "normal";

// What each level actually does, in the operator's words.
//
// Kept beside LEVELS because these strings and these three names describe one
// thing. The onboarding prompt is assembled from both, and an answer is matched
// against both — so a level added without a description, or a description that
// no longer describes what the code does, shows up as a prompt that offers a
// choice it cannot record.
export const LEVEL_DESCRIPTIONS = {
  safe: "asks before every change to files and every command",
  normal: "asks before anything irreversible or that leaves this machine",
  permissive: "does not ask — hard blocks still apply",
};

/**
 * The prompt's options, derived from LEVELS — never written out separately.
 *
 * The key is the first letter, which is what "[n]ormal" tells the operator to
 * type. Deriving it means the bracket and the accepted key cannot disagree:
 * a level whose key is undefined below is one the prompt would offer and the
 * parser could not record, which is the exact bug this replaced (the
 * prompt said "pick s, n or p" and only the full words were accepted, so typing
 * `n` was silently discarded and the question came back on every start).
 */
export function levelOptions() {
  return LEVELS.map((level) => {
    const description = LEVEL_DESCRIPTIONS[level];
    if (!description) {
      throw new Error(`Level "${level}" has no description in LEVEL_DESCRIPTIONS; it would be offered and then not recorded`);
    }
    return { level, key: level.slice(0, 1), description };
  });
}

/**
 * Read an answer to the onboarding question, in any spelling it offers.
 *
 * Accepts the full word (the canonical spelling, and what is stored) or the
 * single letter the prompt shows in brackets. Case-insensitive and whitespace-
 * tolerant, because it is typed once, in a hurry, at first launch.
 *
 * Returns null for anything else. Refusing an unrecognised answer is the safe
 * direction: the question is asked again next start and the documented default
 * applies meanwhile, rather than a posture nobody chose being recorded as if
 * they had.
 *
 * @param {string|null|undefined} answer
 * @returns {string|null} a member of LEVELS, or null
 */
export function parseLevelAnswer(answer) {
  if (answer == null) return null;
  const text = String(answer).trim().toLowerCase();
  if (!text) return null;
  if (LEVELS.includes(text)) return text;
  // More than one level sharing a first letter makes the letter ambiguous, and
  // guessing which one was meant would silently pick a posture. Fail to null
  // instead — the operator is asked again rather than answered wrongly.
  const matches = levelOptions().filter((o) => o.key === text);
  return matches.length === 1 ? matches[0].level : null;
}

/**
 * Which dangerous-command patterns ask, by level.
 *
 * The list is indexed rather than copied three times: three copies of one list
 * would drift, and a drift here means the level silently does not do what the
 * operator chose.
 *
 * @param {string} level
 * @returns {RegExp[]}
 * @throws if the level is not one of LEVELS — a typo must not fall back to a
 *   posture nobody chose
 */
export function dangerousPatternsThatAsk(level) {
  if (!LEVELS.includes(level)) {
    throw new Error(`Unknown security level: ${level}. Expected one of: ${LEVELS.join(", ")}`);
  }
  if (level === "permissive") return [];

  // safe asks about EVERY command, including `ls -la`.
  //
  // Not a pattern list but a marker: any command is a "pattern that asks" when
  // the operator has said they want to approve every action. That is what the
  // level means in the onboarding question — "before every change to files and
  // every command" — and expressing it as a list of patterns could only ever be
  // a list of the commands somebody thought of in advance. `ls -la` is the
  // plainest way to see a level that claims to be safe while quietly permitting
  // whatever nobody wrote down.
  if (level === "safe") return [ASK_EVERY_COMMAND];

  // normal: the destructive half, plus everything that is a one-way door.
  //
  // The destructive flag says the worst case is unrecoverable work. On its own
  // it was too narrow, and the gap was real: a plain `git push` destroys
  // nothing locally, and a `mail` command destroys nothing at all — but both
  // are irreversible in the sense the operator cares about, which is that other
  // people now have it, or it has left this machine, and there is no undo for
  // either. The default level asks about anything irreversible OR that leaves
  // this machine, so both lists belong here.
  //
  // One list entry can match twice (npm publish is both destructive and
  // one-way); harmless for a `test()` probe, and de-duplicating here would be
  // bookkeeping for its own sake.
  return [
    ...DANGEROUS_COMMAND_PATTERNS.filter((e) => e.destructive).map((e) => e.re),
    ...ONE_WAY_PATTERNS,
  ];
}

/**
 * Tools the `normal` level runs without asking, when their default is to ask.
 *
 * Local changes that can be undone (/rewind restores files) and commands. A
 * command is not exempt from judgement here: the command guard still asks about
 * every destructive or one-way pattern at this level (git push, rm -rf, mail).
 * Deleting a file, starting another agent, mail, plugins and any tool nobody
 * has classified (MCP) still ask.
 */
const ALWAYS_ASKS = new Set(["delete_file", "reconnect_mcp"]);

const NORMAL_RUNS_WITHOUT_ASKING = new Set([
  "write_file", "edit_file", "copy_file", "move_file", "create_directory",
  "run_command", "run_background_command", "kill_process",
]);

/**
 * What a tool's default permission becomes at a level.
 *
 * Owner, 2026-10-01: the three levels changed only which command patterns ask,
 * so every run_command and every write asked at every level, permissive
 * included, although the onboarding question promised otherwise. The level
 * now decides the tool defaults too. Only a default of "confirm" is relaxed; an
 * explicit per-tool setting (/allow, /deny, /confirm) is applied before this,
 * and the forced prompts (secret files, plugins, dangerous commands) are hooks
 * this does not touch.
 *
 * @param {string} level - one of LEVELS
 * @param {string} name - tool name
 * @param {string} base - the tool's default: "allow" | "confirm" | "deny"
 * @returns {string}
 */
export function toolPermissionAtLevel(level, name, base) {
  if (base !== "confirm") return base;
  // Asks at every level: deleting a file cannot be undone, and reconnect_mcp
  // acts on a server name that came out of an error message (FLINT.md).
  if (ALWAYS_ASKS.has(name)) return "confirm";
  if (level === "permissive") return "allow";
  if (level === "normal" && NORMAL_RUNS_WITHOUT_ASKING.has(name)) return "allow";
  return "confirm";
}

/**
 * The pattern that means "any command at all" — the `safe` level, spelled out.
 *
 * Exported so the tests and the status line can name the same thing, and so a
 * caller can tell "asks about everything" apart from "asks about a list" without
 * matching on the level string.
 */
export const ASK_EVERY_COMMAND = /[\s\S]*/;

export const SECRET_FILE_PATTERNS = [
  /\.env$/i,
  /\.env\..+$/i,
  /credentials\.json$/i,
  /\.pem$/i,
  /\.key$/i,
  /id_rsa$/i,
  /id_ed25519$/i,
  /id_ecdsa$/i,
  /\.pgpass$/i,
  /\.netrc$/i,
];

// Command deny patterns — dangerous shell commands
export const COMMAND_DENY_PATTERNS = [
  /rm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?(-[a-zA-Z]*r[a-zA-Z]*\s+)?\//,  // rm -rf /
  /rm\s+(-[a-zA-Z]*r[a-zA-Z]*\s+)?(-[a-zA-Z]*f[a-zA-Z]*\s+)?\//,  // rm -fr /
  /:\(\)\s*\{\s*:\|:\s*&\s*\}\s*;/,       // fork bomb :(){ :|:& };
  /\|\s*(ba)?sh\b/,                        // curl | bash
  /\|\s*bash\b/,                           // pipe to bash
  /powershell\s+.*-[eE]nc/,               // powershell -enc (obfuscated)
  /\bformat\s+[a-zA-Z]:\s*/i,             // format C:
  /\bdd\s+.*of=\/dev\//,                  // dd of=/dev/
  /\bmkfs\b/,                             // mkfs
  // cmd.exe has no backslash escape: `"C:\"` is the quoted drive, so allow the quote.
  /\bdel\s+\/[sS]\s+\/[qQ]\s+['"]?[a-zA-Z]:\\/i, // del /s /q C:\
  // The Windows ways to the same damage (owner, 2026-10-02): a model refused
  // `format C:` can reach for these. Whole disks and drive roots only; a
  // recursive delete of a folder stays a question, not a block.
  /\bFormat-Volume\b/i,                    // Format-Volume -DriveLetter C
  /\bClear-Disk\b/i,                       // Clear-Disk -RemoveData
  /\bdiskpart\b/i,                         // diskpart (clean, format, delete partition)
  /\b(rd|rmdir)\s+(\/[sq]\s+){2}['"]?[a-zA-Z]:\\?['"]?(\s|$)/i, // rd /s /q C:\
  /\bRemove-Item\b(?=[^|;&]*\s-Recurse)(?=[^|;&]*\s['"]?[a-zA-Z]:\\?\*?['"]?(\s|$|"))/i, // Remove-Item -Recurse C:\
];

// Commands that need forced confirmation even when permission is "allow".
//
// `destructive: true` marks the ones whose worst case is unrecoverable work —
// a recursive delete, a lost commit, a published package, a pruned cluster.
// Those still ask at the normal level. chmod 777 and the rest are ordinary
// things a person does on purpose while working, and only ask if the operator
// chose `safe`.
//
// The flag lives here rather than in a parallel list beside this one, because
// two lists drift and a drift means a level silently stops doing what the
// operator chose. Note it cannot be derived from the pattern's source: the
// source of /\brm\s+-r/ is the *string* "\brm\s+-r", so a filter regex
// expecting real whitespace after "rm" can never match it. That was tried, and
// it selected zero patterns — precisely the near-silent failure a parallel list
// exists to prevent.
export const DANGEROUS_COMMAND_PATTERNS = [
  { re: /\brm\s+-[a-zA-Z]*r/, destructive: true },          // rm -r (recursive delete)
  { re: /\bgit\s+push\s+.*--force/, destructive: true },    // git push --force
  { re: /\bgit\s+reset\s+--hard/, destructive: true },      // git reset --hard
  { re: /\bgit\s+clean\s+-[a-zA-Z]*f/, destructive: true }, // git clean -f
  { re: /\bchmod\s+777\b/, destructive: false },            // chmod 777
  { re: /\bnpm\s+publish\b/, destructive: true },           // npm publish
  { re: /\bdocker\s+rm\b/, destructive: true },             // docker rm
  { re: /\bdocker\s+system\s+prune/, destructive: true },   // docker system prune
  { re: /\bkubectl\s+delete\b/, destructive: true },        // kubectl delete
];

// Commands that are irreversible, or that send something off this machine.
//
// Two kinds, and the distinction is the spec's: a command that destroys work
// nobody can get back, and a command that puts data somewhere else. Both are
// one-way doors — there is no "un-push", no "un-send", and no getting the
// branch back once someone else has pulled.
//
// Kept beside DANGEROUS_COMMAND_PATTERNS rather than merged into it. That list
// is the guard's allow/deny vocabulary; this one is the question of *whether to
// ask*, which is a level's job. A pattern in both is not a duplicate — the
// guard refuses it outright, and a level still needs to know it is a one-way
// door.
export const ONE_WAY_PATTERNS = [
  /\bgit\s+push\b/,                    // a plain push, not just --force:
                                          // other people have the branch now
  /\bnpm\s+publish\b/,                 // cannot be un-published
  /\bdocker\s+push\b/,
  /\bkubectl\s+(apply|delete)\b/,
  /\bgh\s+(pr\s+merge|release\s+create)\b/,
  // Leaves this machine, carrying the operator's own data out.
  //
  // Deliberately NOT a bare `\bcurl\b`. A first draft listed every curl and
  // every wget here, on the reasoning that "curl talks to the network". That
  // made the default level ask about `curl https://api.example.com/v1/x` — a
  // read, the same class of thing as read_file, which criterion 1 says must not
  // ask. Asking about every fetch is the prompt-fatigue failure the whole
  // change exists to fix, and it is the failure the owner actually hit on
  // 2026-09-29: prompts that stopped being decisions.
  //
  // So what asks is a request that carries something out — a body, a file, a
  // non-idempotent method. A GET that returns nothing the operator already has
  // discloses nothing and is not a one-way door. `curl -d`, `curl -F` and
  // `curl -T` are.
  /\bcurl\b[^\n|]*\s(?:-d\b|-F\b|-T\b|--data[\w-]*\b|--form\b|--upload-file\b|-X\s*(?:POST|PUT|PATCH|DELETE)\b|-XPOST\b|-XPUT\b|-XPATCH\b|-XDELETE\b)/,
  /\bwget\b[^\n]*\s(?:--post-data\b|--post-file\b|--body-data\b)/,
  // Sending mail. Anchored to the command position, because a bare `\bmail\b`
  // also matches `grep bob@mail.example.com` — an address inside a search, not
  // a message being sent.
  /^\s*(?:sudo\s+)?(?:mail|mailx|sendmail|mutt)\b/,
  /\bsendmail\b/,
  // File transfer off this machine. rsync is listed plainly rather than keyed
  // on a flag: the earlier `\brsync\b.*\s-\S*e\b` keyed on `-e` (the remote
  // shell flag, not an upload flag) and so missed the ordinary `rsync -a
  // ./a host:/b`, which is the case that matters.
  /\bscp\b/,
  /\brsync\b/,
  /\bsftp\b/,
  /\bnc\b|\btelnet\b|\bftp\b/,         // opens a channel
];

const PROFILES = {
  strict: {
    name: "strict",
    criticalDenylist: CRITICAL_DENYLIST,
    secretPatterns: SECRET_PATTERNS,
    secretFilePatterns: SECRET_FILE_PATTERNS,
    commandDenyPatterns: COMMAND_DENY_PATTERNS,
    // The guard (src/security/command-guard.js) matches with `pattern.test(...)`,
    // so it takes the regexes, not the tagged entries. The `destructive` flag
    // exists for the level split, and unwrapping here keeps the guard's
    // interface unchanged rather than teaching two shapes to one consumer.
    dangerousCommandPatterns: DANGEROUS_COMMAND_PATTERNS.map((e) => e.re),
    network: {
      blockPrivateIPs: true,
      blockNonHttpProtocols: true,
      rateLimit: { maxPerMinute: 30, windowMs: 60000 },
    },
    child: {
      maxDepth: 2,
    },
    // Strict: also deny writing to home directory root files
    extraDenyPaths: [
      path.join(homeDir, ".bashrc"),
      path.join(homeDir, ".bash_profile"),
      path.join(homeDir, ".profile"),
      path.join(homeDir, ".zshrc"),
    ],
  },

  normal: {
    name: "normal",
    criticalDenylist: CRITICAL_DENYLIST,
    secretPatterns: SECRET_PATTERNS,
    secretFilePatterns: SECRET_FILE_PATTERNS,
    commandDenyPatterns: COMMAND_DENY_PATTERNS,
    dangerousCommandPatterns: DANGEROUS_COMMAND_PATTERNS.map((e) => e.re),
    network: {
      blockPrivateIPs: true,
      blockNonHttpProtocols: true,
      rateLimit: { maxPerMinute: 60, windowMs: 60000 },
    },
    child: {
      maxDepth: 5,
    },
    extraDenyPaths: [],
  },

  permissive: {
    name: "permissive",
    criticalDenylist: CRITICAL_DENYLIST,
    secretPatterns: SECRET_PATTERNS,
    secretFilePatterns: SECRET_FILE_PATTERNS,
    commandDenyPatterns: COMMAND_DENY_PATTERNS,
    dangerousCommandPatterns: [],  // no forced confirm for dangerous commands
    network: {
      blockPrivateIPs: false,
      blockNonHttpProtocols: true,
      rateLimit: { maxPerMinute: 120, windowMs: 60000 },
    },
    child: {
      maxDepth: 10,
    },
    extraDenyPaths: [],
  },
};

/**
 * Load security policy based on config or env var.
 * @param {object} config - App config (must have securityPolicy field)
 * @returns {object} policy object
 */
export function loadPolicy(config) {
  const name = config.securityPolicy || process.env.AGENT_SECURITY_POLICY || "normal";
  const policy = PROFILES[name];
  if (!policy) {
    console.error(`[security] Unknown policy "${name}", falling back to "normal"`);
    return PROFILES.normal;
  }

  // Enforce minimum safety floor — policy can restrict but not weaken core protections
  if (!policy.criticalDenylist?.length) {
    policy.criticalDenylist = CRITICAL_DENYLIST;
  }
  if (!policy.secretPatterns?.length) {
    policy.secretPatterns = SECRET_PATTERNS;
  }
  if (!policy.commandDenyPatterns?.length) {
    policy.commandDenyPatterns = COMMAND_DENY_PATTERNS;
  }

  return policy;
}
