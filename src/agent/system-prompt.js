import { swapEnabled } from "./swap.js";
import { getSpendLevel, spendSettings } from "../spend.js";
import os from "node:os";

const ECONOMY_ADVICE = [
  "## Spending tokens (economy mode)",
  "",
  "Every call sends the whole conversation again, so keep it short:",
  "- Search before reading (`search_in_files`, `glob`), and read the part of a file you need (offset/limit), not all of it.",
  "- Read a page once and note what matters in your reply; do not fetch it again (`swap_read` brings back what was read).",
  "- Make independent tool calls in one response.",
  "- Answer briefly; no recaps of what you already said.",
].join("\n");
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { readMemoryMdHead } from "../memory/markdown.js";
import { getSessionFactsSummary } from "../memory/session-facts.js";
import { getDigestForPrompt } from "../memory/conversation-digest.js";
import { loadRecent as loadRecentReflections, formatForPrompt as formatReflections } from "../memory/reflections.js";
import { compilePreferences, formatForPrompt as formatPatterns } from "../memory/patterns.js";
import { createBudgetAllocator } from "./prompt-budget.js";
import { formatForPrompt as formatSkills, syncFromDisk as syncSkills } from "../memory/skills.js";
import { formatForPrompt as formatFacts } from "../memory/facts.js";
import { getCurrentProject } from "../memory/project.js";
import { formatForPrompt as formatUserModel } from "../memory/user-model.js";
import { compileRules, formatForPrompt as formatRules } from "../memory/rules.js";
import { getDefinitions } from "../tools/registry.js";
import { detectInjection } from "../security/content-fence.js";
import { formatFlintMdBlock } from "./project-context.js";
import { inboxPromptHint } from "../memory/inbox.js";
import { getModeForIntent } from "./modes.js";
import { config } from "../config.js";

// --- System context (system.md — ships with Flint) ---

function loadSystemMd() {
  // Only Flint's own copy. cwd used to be tried first, so any folder the user
  // started Flint in that held a file called system.md replaced the whole core
  // prompt without a word. A project speaks through FLINT.md instead.
  const p = join(new URL("../..", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1"), "system.md");
  try {
    if (existsSync(p)) {
      const text = readFileSync(p, "utf-8").trim();
      // With swap off the swap rule describes tools that are not there, and
      // FLINT_SWAP=0 promises the prompt as it was (docs/context-swap.md, A4).
      const base = swapEnabled() ? text : text.split("\n").filter((l) => !l.includes("swap_read")).join("\n");
      // Economy mode only (spend.js): in the other modes the advice would
      // make the agent hold back for no reason.
      return spendSettings(getSpendLevel()).advice ? `${base}\n\n${ECONOMY_ADVICE}` : base;
    }
  } catch {}
  return null;
}

// --- Flint capability summary (from bundled README.md) ---
// Extracts the "What can it do?" section and the Features headings from
// Flint's own README. Injected into the system prompt so meta-questions
// ("what do you support?", "do you work with MCP?") answer from a live source
// that tracks actual Flint architecture — no hardcoded capability list,
// no decay, no ambiguity about which README to read.

function loadFlintCapabilities() {
  let text = null;
  try {
    const flintRoot = new URL("../..", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");
    const readmePath = join(flintRoot, "README.md");
    if (existsSync(readmePath)) text = readFileSync(readmePath, "utf-8");
  } catch {}
  if (!text) return null;

  // "## What can it do?" section up to next top-level heading
  const canDoMatch = text.match(/## What can it do\?([\s\S]*?)(?=\n## |\n# |$)/);
  const canDo = canDoMatch ? canDoMatch[1].trim() : "";

  // Features headings + first meaningful prose paragraph per feature.
  // Skips markdown tables (| ... |), code fences (```), and list-only
  // blocks so the captured blurb is actually descriptive. This matters
  // because e.g. the MCP feature leads with a big tool-category table
  // and only explains itself in a prose paragraph below it — without
  // skipping the table the agent has no signal about what MCP means
  // and defaults to hallucinating "Minecraft Coder Pack".
  const featuresMatch = text.match(/## Features([\s\S]*?)(?=\n## |\n# |$)/);
  const featureLines = [];
  if (featuresMatch) {
    const lines = featuresMatch[1].split("\n");
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i].trim();
      if (!l.startsWith("### ")) continue;
      const heading = l.replace(/^### /, "");
      let blurb = "";
      let inCodeFence = false;
      // Scan up to 25 lines after the heading or until next heading
      for (let j = i + 1; j < Math.min(i + 25, lines.length); j++) {
        const raw = lines[j];
        const ln = raw.trim();
        if (ln.startsWith("### ") || ln.startsWith("## ") || ln.startsWith("# ")) break;
        if (ln.startsWith("```")) { inCodeFence = !inCodeFence; continue; }
        if (inCodeFence) continue;
        // Skip markdown table rows and separator lines
        if (ln.startsWith("|")) continue;
        if (!ln) { if (blurb) break; else continue; }
        blurb += (blurb ? " " : "") + ln;
        if (blurb.length > 320) { blurb = blurb.slice(0, 320) + "..."; break; }
      }
      featureLines.push(blurb ? `- ${heading} — ${blurb}` : `- ${heading}`);
    }
  }

  const parts = [];
  if (canDo) parts.push(canDo);
  if (featureLines.length) parts.push("Feature highlights:\n" + featureLines.join("\n"));
  return parts.length ? parts.join("\n\n") : null;
}

// FLINT.md loading moved to ./project-context.js — shared across classifier,
// agent loop, and any other LLM-call site. See that module for the loader
// and the trusted-context wrapping.

const MAX_CONTEXT_CHARS = config.maxContextChars;

// --- OS detection ---

function getOsInfo() {
  const platform = process.platform;
  if (platform === "win32") {
    return {
      name: "Windows",
      shell: "bash (via run_command)",
      shellTips: "run_command uses bash even on Windows. Use Unix commands (ls, cat, grep, find). Do NOT use cmd.exe or PowerShell commands.",
    };
  }
  if (platform === "darwin") {
    return {
      name: "macOS",
      shell: "zsh",
      shellTips: "Standard Unix commands. Paths use forward slashes.",
    };
  }
  return {
    name: "Linux",
    shell: "bash",
    shellTips: "Standard Unix commands. Paths use forward slashes.",
  };
}

// --- Dynamic tool list from registry ---

function getToolList() {
  const tools = getDefinitions();
  if (!tools.length) return "";

  // Group tools by category based on name patterns
  const categories = {
    filesystem: { label: "LOCAL FILESYSTEM (this machine)", names: new Set(["read_file", "write_file", "list_directory", "create_directory", "copy_file", "move_file", "delete_file", "search_in_files", "view_image", "edit_file", "glob"]) },
    process: { label: "LOCAL PROCESS (this machine)", names: new Set(["run_command", "run_background_command", "kill_process", "list_processes", "peek_process"]) },
    web: { label: "WEB", names: new Set(["web_fetch", "web_search"]) },
    agent: { label: "MULTI-AGENT", names: new Set(["spawn_agent", "ask_agent", "list_agents"]) },
    memory: { label: "MEMORY", names: new Set(["memory_write", "memory_search", "memory_get", "memory_delete"]) },
    planning: { label: "PLANNING", names: new Set(["create_plan", "update_task", "list_tasks", "add_task", "add_task_note", "link_task_file"]) },
    desktop: { label: "LOCAL DESKTOP (built-in, this machine)", names: new Set(["desktop_screenshot", "desktop_look", "desktop_click", "desktop_type", "desktop_key", "desktop_chrome", "desktop_resume", "desktop_batch", "desktop_shell", "desktop_window", "desktop_manage", "desktop_file", "desktop_wait_stable", "desktop_wait_change"]) },
    mesh: { label: "MESH MEMORY", names: new Set(["mesh_search", "mesh_add", "mesh_recent"]) },
    dataset: { label: "DATASETS", names: new Set(["show_dataset"]) },
    system: { label: "SYSTEM", names: new Set(["restart_agent", "clear_context", "check_balance", "think", "list_models", "switch_model", "switch_provider", "list_providers", "check_inbox"]) },
  };

  const grouped = {};
  const uncategorized = [];

  for (const tool of tools) {
    const name = tool.function.name;
    let found = false;

    // Check exact name match in built-in categories
    for (const [key, cat] of Object.entries(categories)) {
      if (cat.names.has(name)) {
        if (!grouped[key]) grouped[key] = { label: cat.label, tools: [] };
        grouped[key].tools.push(name);
        found = true;
        break;
      }
    }

    // MCP tools: auto-group by server name (mcp_<server>_<tool>)
    if (!found && name.startsWith("mcp_")) {
      const parts = name.split("_");
      const serverName = parts[1] || "unknown";
      const mcpKey = `mcp_${serverName}`;
      if (!grouped[mcpKey]) grouped[mcpKey] = { label: `MCP: ${serverName} (remote)`, tools: [] };
      grouped[mcpKey].tools.push(name);
      found = true;
    }

    if (!found) {
      uncategorized.push(name);
    }
  }

  const sections = [];
  for (const key of Object.keys(categories)) {
    if (grouped[key]) {
      sections.push(`${grouped[key].label}: ${grouped[key].tools.join(", ")}`);
    }
  }
  if (uncategorized.length) {
    sections.push(`OTHER: ${uncategorized.join(", ")}`);
  }

  return sections.join("\n\n");
}

// --- Build system prompt ---

function buildPrompt(opts = {}) {
  const { profile, profileContent } = opts;
  const osInfo = getOsInfo();

  const parts = [];

  // Core prompt loaded from system.md (no hardcoded instructions in code)
  const systemMd = loadSystemMd();
  if (systemMd) {
    parts.push(systemMd);
  } else {
    parts.push("You are FLINT, a technical AI agent that executes tasks using available tools.");
  }

  // Project rules (FLINT.md) — immediately after system.md, before profile.
  // This is the agent's own project notebook: facts about the current
  // project, conventions, server names, workspace identifiers, shortcuts.
  // Trusted because it's maintained by the agent itself (scanned for
  // injection). Placed high in the prompt so it's not lost in context
  // middle. See src/agent/project-context.js for the loader.
  const flintMdBlock = formatFlintMdBlock(process.cwd());
  if (flintMdBlock) {
    parts.push("");
    parts.push(flintMdBlock);
  }

  // Profile prompt (injected from profile .md file)
  if (profileContent) {
    parts.push("");
    parts.push(`--- ROLE: ${profile || "custom"} ---`);
    parts.push(profileContent);
    parts.push("--- END ROLE ---");
  }

  // Environment, the part of it that does not move. The clock used to live on
  // this line, in the middle of the section the layout calls FIXED, at minute
  // resolution: it changed the prefix every later token is cached against
  // roughly once a minute. It is now a per-turn section below the boundary.
  parts.push("");
  parts.push(`ENVIRONMENT: ${osInfo.name} (${os.arch()}) | Shell: ${osInfo.shell} | CWD: ${process.cwd()}`);
  if (osInfo.name === "Windows") parts.push("Shell uses bash. Use Unix commands (ls, cat, grep), not PowerShell.");

  // Task-driven child agent instructions
  if (process.env.AGENT_TASK_ID) {
    parts.push("");
    parts.push([
      `CHILD AGENT MODE: Executing task #${process.env.AGENT_TASK_ID}.`,
      "Focus ONLY on this task. Use update_task to report progress. Auto-completed on exit.",
    ].join("\n"));
  }

  return parts.join("\n");
}

// --- Agent-memory prefetch ---
let _agentMemoryContext = null;

export async function prefetchAgentMemory() {
  try {
    const { execFileSync } = await import("node:child_process");
    // Try to find agent-memory binary
    const bins = [
      process.env.AGENT_MEMORY_BIN,
      "agent-memory",
      "agent-memory.exe",
    ].filter(Boolean);
    for (const bin of bins) {
      try {
        const result = execFileSync(bin, ["context", "--budget", "3000"], {
          encoding: "utf-8",
          timeout: 5000,
          stdio: ["pipe", "pipe", "ignore"],
        }).trim();
        if (result && result.length > 10) {
          _agentMemoryContext = result;
          return result;
        }
      } catch {}
    }
  } catch {}
  return null;
}

// --- Public API ---

export function getSystemMessage(sessionId, opts = {}) {
  const allocator = createBudgetAllocator();

  // ── FIXED SECTIONS (never truncated) ──

  // Nothing added here may vary within a session. Everything downstream is
  // cached against this text, so a single moving character in it costs the
  // whole prompt. The mode block used to be appended right here and changes
  // with the intent class, which changes every turn; it is a per-turn section
  // now.
  const coreContent = buildPrompt(opts);

  allocator.addSection("core", coreContent, { priority: 1, fixed: true });

  // Flint architectural capabilities (from bundled README) — injected
  // so self-description questions have a live source without the agent
  // needing to guess or read an ambiguous README from the user's cwd.
  const capabilitiesText = loadFlintCapabilities();
  if (capabilitiesText) {
    allocator.addSection(
      "flint-capabilities",
      `<trusted-context name="flint-capabilities" source="README.md">\n${capabilitiesText}\n</trusted-context>`,
      { priority: 2, min: 300, max: 2500 },
    );
  }

  // ── SESSION-STABLE ZONE (cached across turns, budgeted) ──

  const memoryContent = readMemoryMdHead(50);
  if (memoryContent) {
    const scan = detectInjection(memoryContent);
    const memText = (scan.detected && scan.score >= 3)
      ? `[BLOCKED: MEMORY.md failed injection scan (score ${scan.score})]`
      : memoryContent;
    allocator.addSection("memory-md", `<untrusted-context name="memory" source="MEMORY.md">\n${memText}\n</untrusted-context>`, { priority: 3, min: 200, max: 2000 });
  }

  if (_agentMemoryContext) {
    allocator.addSection("agent-memory", `<trusted-context name="agent-memory">\n${_agentMemoryContext}\n</trusted-context>`, { priority: 3, min: 500, max: 3000 });
  }

  // Memory Layer 1: reflections
  try {
    const recentReflections = loadRecentReflections(5);
    const reflectionsText = formatReflections(recentReflections);
    if (reflectionsText) {
      allocator.addSection("reflections", `<trusted-context name="past-lessons">\n${reflectionsText}\n</trusted-context>`, { priority: 4, min: 200, max: 1500 });
    }
  } catch {}

  // Memory Layer 2: patterns
  try {
    const prefs = compilePreferences();
    const patternsText = formatPatterns(prefs);
    if (patternsText) {
      allocator.addSection("patterns", `<trusted-context name="tool-patterns">\n${patternsText}\n</trusted-context>`, { priority: 4, min: 200, max: 1500 });
    }
  } catch {}

  // Memory Layer 3: skills (index only)
  try {
    syncSkills();
    const skillsText = formatSkills();
    if (skillsText) {
      const scan = detectInjection(skillsText);
      const text = (scan.detected && scan.score >= 3)
        ? `<trusted-context name="skills">\n[BLOCKED: skills content failed injection scan (score ${scan.score}).]\n</trusted-context>`
        : `<untrusted-context name="skills" source="~/.flint/memory/skills/">\n${skillsText}\n</untrusted-context>`;
      allocator.addSection("skills", text, { priority: 5, min: 100, max: 1000 });
    }
  } catch {}

  // Memory Layer 4: facts
  try {
    const currentProject = getCurrentProject();
    const factsText = formatFacts(500, currentProject);
    if (factsText) {
      const scan = detectInjection(factsText);
      const text = (scan.detected && scan.score >= 3)
        ? `<trusted-context name="facts">\n[BLOCKED: facts failed injection scan (score ${scan.score})]\n</trusted-context>`
        : `<untrusted-context name="facts" source="user-extracted">\n${factsText}\n</untrusted-context>`;
      allocator.addSection("facts", text, { priority: 5, min: 100, max: 500 });
    }
  } catch {}

  // Memory Layer 5: user model
  try {
    const userModelText = formatUserModel(0.5);
    if (userModelText) {
      allocator.addSection("user-profile", `<trusted-context name="user-profile">\n${userModelText}\n</trusted-context>`, { priority: 5, min: 50, max: 300 });
    }
  } catch {}

  // ── DYNAMIC BOUNDARY ──
  allocator.addSection("boundary", "__DYNAMIC_BOUNDARY__", { priority: 1, fixed: true });

  // ── PER-TURN ZONE ──

  // The mode. It moves with the intent class, so it lives below the boundary
  // in the per-turn zone. Fixed, because a truncated half of a mode is worse than a longer
  // prompt.
  //
  // No clock here any more. Even below the boundary a line that moves
  // every minute is still ABOVE the tools on a model whose template renders
  // them after the system message, so every new task paid for the tools and
  // the request again: one benchmark run cached 4096-6144 of ~7500 tokens on Flint's
  // first calls against ~99% for a reference agent, and Flint paid 2.3x. system.md tells
  // the agent to ask the system for the date and time when it needs them.
  let perTurn = "";
  if (opts.intentClass) {
    try {
      const mode = getModeForIntent(opts.intentClass);
      if (mode && mode.promptAddition) {
        perTurn = `<trusted-context name="mode">\n${mode.promptAddition}\n</trusted-context>`;
      }
    } catch {}
  }
  if (perTurn) allocator.addSection("turn-context", perTurn, { priority: 1, fixed: true });

  if (sessionId) {
    const sessionFacts = getSessionFactsSummary(sessionId, 30);
    if (sessionFacts) {
      allocator.addSection("session-facts", `<trusted-context name="session-facts">\nKey facts extracted from this conversation so far:\n${sessionFacts}\n</trusted-context>`, { priority: 6, min: 100, max: 2000 });
    }
    const digest = getDigestForPrompt(sessionId, 25);
    if (digest) {
      allocator.addSection("digest", `<trusted-context name="conversation-digest">\n${digest}\nUse this to recall what the user asked and what you answered in previous turns.\n</trusted-context>`, { priority: 6, min: 200, max: 3000 });
    }
  }

  if (opts.datasets) {
    const entries = Object.values(opts.datasets);
    if (entries.length > 0) {
      const lines = entries.map((ds) => {
        const totalPages = Math.ceil(ds.rows.length / ds.pageSize);
        return `  ${ds.id} "${ds.label}" ${ds.rows.length} rows, page ${ds.page}/${totalPages} (source: ${ds.source})`;
      });
      allocator.addSection("datasets", `<trusted-context name="datasets">\n${lines.join("\n")}\nUse show_dataset(id, page) to view pages.\n</trusted-context>`, { priority: 7, min: 50, max: 500 });
    }
  }

  const inboxHint = inboxPromptHint();
  if (inboxHint) {
    allocator.addSection("inbox", `<trusted-context name="notifications">\n${inboxHint}\n</trusted-context>`, { priority: 8, min: 20, max: 200 });
  }

  const { prompt } = allocator.build();
  return { role: "system", content: prompt };
}
