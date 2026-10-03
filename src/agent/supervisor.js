// Real-time Supervisor — observes tool calls and injects hints
// Toggle: /supervisor on|off
// Zero cost — local pattern matching + knowledge search, no API calls

import { createLogger } from "../logging/logger.js";

const log = createLogger("supervisor");

let _enabled = false; // toggled by /supervisor or auto-enabled for API messages
let _knowledgeSearchFn = null; // injected from outside
let _lastTools = []; // last N tool calls for pattern detection
let _hintCounts = {}; // per-rule escalation counter
let _lastExpect = null; // EXPECT string from last assistant message

export function setSupervisorEnabled(enabled) {
  _enabled = enabled;
  log.info("supervisor", { enabled });
}

export function isSupervisorEnabled() {
  return _enabled;
}

export function setSupervisorKnowledgeFn(fn) {
  _knowledgeSearchFn = fn;
}

/**
 * Called after each tool execution, before next API call.
 * Returns hint string to inject as system message, or null if no hint needed.
 */
export function evaluateToolCall(toolName, args, result, context = {}) {
  if (!_enabled) return null;

  const hints = [];

  // Track recent tools
  _lastTools.push({ name: toolName, args, ts: Date.now() });
  if (_lastTools.length > 10) _lastTools.shift();

  // --- Rule: click without prior look ---
  if (toolName.includes("click") && !toolName.includes("chrome")) {
    const lastLook = _lastTools.slice(0, -1).reverse().find(t => t.name.includes("look"));
    const lastScreenshot = _lastTools.slice(0, -1).reverse().find(t => t.name.includes("screenshot"));
    if (!lastLook || (lastScreenshot && lastScreenshot.ts > lastLook.ts)) {
      hints.push("HINT: Always use desktop_look(cell=N) BEFORE clicking to get precise coordinates. Screenshot coordinates are wrong (image is resized).");
    }
  }

  // --- Rule: clicking same coordinates repeatedly ---
  if (toolName.includes("click")) {
    const recentClicks = _lastTools.filter(t => t.name.includes("click")).slice(-3);
    if (recentClicks.length >= 3) {
      const coords = recentClicks.map(t => `${t.args?.x},${t.args?.y}`);
      if (coords[0] === coords[1] && coords[1] === coords[2]) {
        hints.push("HINT: You clicked the same coordinates 3 times. The click is missing its target. Use desktop_look on a DIFFERENT cell to find the element, or try keyboard shortcut instead (Escape, Alt+N, Alt+Y, Tab+Enter).");
      }
    }
  }

  // --- Rule: local tool used when remote desktop tools were active ---
  const LOCAL_TOOLS = new Set(["run_command", "write_file", "edit_file", "delete_file", "copy_file", "move_file"]);
  if (LOCAL_TOOLS.has(toolName)) {
    const hasRemoteDesktop = _lastTools.some(t => t.name.includes("desktop_") && t.name.startsWith("mcp_"));
    if (hasRemoteDesktop) {
      const remoteShell = _lastTools.find(t => t.name.includes("desktop_shell"))?.name || "desktop_shell";
      hints.push(`HINT: You used a LOCAL tool (${toolName}) but this session has remote desktop tools active. Use ${remoteShell} for commands on the remote desktop. Local tools execute on YOUR machine, not the remote desktop.`);
    }
  }

  // --- Rule: GUI app launched via shell — remind to activate window ---
  if (toolName.includes("shell")) {
    const cmd = args?.command || "";
    const guiApps = ["soffice", "libreoffice", "gimp", "inkscape", "mousepad", "xfce4-terminal", "thunar", "firefox", "chromium"];
    const launchedGui = guiApps.some(app => cmd.includes(app)) && cmd.includes("&");
    if (launchedGui) {
      hints.push("HINT: You launched a GUI app in background. It may NOT have focus. Before typing or pasting, use desktop_window(action='list') to find the new window, then desktop_window(action='activate', window_id=...) to give it focus. Otherwise keystrokes go to the wrong window.");
    }
  }

  // --- Rule: paste/type right after shell launch without window activation ---
  if (toolName.includes("key") || toolName.includes("type")) {
    const lastShell = [..._lastTools].reverse().find(t => t.name.includes("shell"));
    const lastActivate = [..._lastTools].reverse().find(t => t.name.includes("window") && t.args?.action === "activate");
    if (lastShell) {
      const shellCmd = lastShell.args?.command || "";
      const isGuiLaunch = shellCmd.includes("&") && (shellCmd.includes("soffice") || shellCmd.includes("mousepad") || shellCmd.includes("gimp") || shellCmd.includes("terminal"));
      if (isGuiLaunch && (!lastActivate || lastActivate.ts < lastShell.ts)) {
        hints.push("HINT: You are typing/pasting but the last shell command launched a GUI app. You have NOT activated that window yet — keystrokes may go to the WRONG window. Use desktop_window(action='activate') first.");
      }
    }
  }

  // --- Rule: apt-get / sudo on screenbox ---
  if (toolName.includes("shell")) {
    const cmd = args?.command || "";
    if (cmd.includes("apt-get") || cmd.includes("sudo")) {
      hints.push("HINT: This desktop does not have root/sudo access. To install apps use: desktop_manage(action=\"install\", app=\"appname\"). To check available apps: desktop_manage(action=\"status\").");
    }
  }

  // --- Rule: libreoffice without DISPLAY ---
  if (toolName.includes("shell")) {
    const cmd = args?.command || "";
    if ((cmd.includes("libreoffice") || cmd.includes("soffice") || cmd.includes("localc")) && !cmd.includes("DISPLAY") && !cmd.includes("--headless")) {
      hints.push("HINT: GUI apps need DISPLAY=:99. Use: desktop_shell(command=\"DISPLAY=:99 soffice --calc &\"). The & runs it in background so the command returns immediately.");
    }
  }

  // --- Rule: libreoffice headless while GUI is open ---
  if (toolName.includes("shell")) {
    const cmd = args?.command || "";
    const resultStr = typeof result === "string" ? result : JSON.stringify(result);
    if (cmd.includes("--headless") && cmd.includes("convert") && (resultStr.includes("error") || resultStr.includes("timeout") || resultStr.includes("exit_code\": 1") || resultStr.includes("exit_code\":1"))) {
      hints.push("HINT: Headless conversion fails when LibreOffice GUI is running. First: desktop_shell(command=\"pkill -f soffice\"), wait 2 seconds, then retry the conversion.");
    }
  }

  // --- Rule: Save As workflow ---
  if (toolName.includes("key")) {
    const keys = args?.keys || "";
    if (keys.toLowerCase() === "ctrl+shift+s") {
      hints.push("HINT: Save As dialog opened. Steps: (1) Type filename in the File name field (Ctrl+A to select existing, then type new name). (2) Change file type dropdown if needed. (3) Navigate to Desktop folder. (4) Click Save. (5) If format confirmation appears, click 'Use Excel Format' or press Alt+Y. If you can't find buttons, use keyboard: Tab to navigate between fields, Enter to confirm.");
    }
  }

  // --- Rule: Recovery/Discard dialog ---
  if (_isScreenObserver(toolName) && typeof result === "string" && (result.includes("recover") || result.includes("Recover") || result.includes("Discard") || result.includes("recovery") || result.includes("Recovery"))) {
    hints.push("HINT: Document Recovery dialog detected. Press alt+d to DISCARD (not Escape — Escape does NOT close this dialog). If alt+d doesn't work, use desktop_look to find the Discard button and click it.");
  }

  // --- Rule: Tip of the Day dialog ---
  if (_isScreenObserver(toolName) && typeof result === "string" && result.includes("Tip of the Day")) {
    hints.push("HINT: 'Tip of the Day' dialog — press Enter or Return to close it.");
  }

  // --- Rule: Text Import dialog ---
  if (_isScreenObserver(toolName) && typeof result === "string" && (result.includes("Text Import") || result.includes("Separator"))) {
    hints.push("HINT: Text Import dialog — Tab separator is usually correct. Press Enter/Return to accept.");
  }

  // --- Rule: unverified write action ---
  // After a write/create action, if next tool is NOT a read/verify, remind to verify
  if (_lastTools.length >= 2) {
    const prev = _lastTools[_lastTools.length - 2];
    const curr = _lastTools[_lastTools.length - 1];
    const isWrite = _isWriteAction(prev.name, prev.args);
    const isVerify = _isVerifyAction(curr.name, curr.args, prev.args);
    if (isWrite && !isVerify) {
      hints.push("HINT: You just performed a write action but did NOT verify the result. Read the file back, check the output, or take a screenshot to confirm success. Never claim success without verification.");
    }
  }

  // --- Rule: same tool repeated WITH SAME ARGS ---
  // Only flag if same tool AND same args across last 3 calls. Different args
  // (e.g. read_file on different paths) is legitimate sequential work, not
  // a loop. Bug fix 2026-04-12: previously only checked name, which flagged
  // every multi-file read/write operation as a false-positive loop.
  if (_lastTools.length >= 3) {
    const last3 = _lastTools.slice(-3);
    const sameToolName = last3.every(t => t.name === last3[0].name);
    if (sameToolName) {
      const argSigs = last3.map(t => {
        try { return JSON.stringify(t.args || {}); } catch { return ""; }
      });
      const sameArgs = argSigs[0] === argSigs[1] && argSigs[1] === argSigs[2];
      if (sameArgs) {
        hints.push("HINT: You called the same tool 3 times in a row with the SAME arguments. The state did not change. Try a different approach or check if the operation is actually needed.");
      }
    }
  }

  // --- Knowledge base lookup ---
  if (_knowledgeSearchFn && hints.length === 0) {
    // Auto-search knowledge when model seems stuck (same tool with same args 2+ times).
    // Bug fix 2026-04-12: previously checked name only, triggering KB search
    // on every legitimate sequential operation.
    const last2 = _lastTools.slice(-2);
    const sameCall = last2.length === 2 && last2[0].name === last2[1].name &&
      (() => { try { return JSON.stringify(last2[0].args || {}) === JSON.stringify(last2[1].args || {}); } catch { return false; } })();
    if (sameCall) {
      try {
        const appName = detectApp(toolName, args, result);
        if (appName) {
          const kb = _knowledgeSearchFn(appName);
          if (kb) {
            hints.push(`KNOWLEDGE (${appName}): ${kb}`);
          }
        }
      } catch (e) {
        log.debug("knowledge search failed", { error: e.message });
      }
    }
  }

  if (hints.length === 0) return null;

  // 4-level escalation: hint → warning → re-plan → hard stop
  // Use tool name + first hint prefix as key (avoids collision between different hints with same prefix)
  const hintKey = toolName + ":" + hints[0].slice(0, 40);
  _hintCounts[hintKey] = (_hintCounts[hintKey] || 0) + 1;
  const count = _hintCounts[hintKey];

  let hint;
  if (count >= 4) {
    // Level 4: HARD STOP
    hint = `[SUPERVISOR OVERRIDE] This hint was given ${count} times and ignored. STOP — the agent cannot recover from this pattern.\n` + hints.join("\n");
    log.warn("supervisor-hard-stop", { tool: toolName, count, key: hintKey });
  } else if (count >= 3) {
    // Level 3: Force re-plan
    hint = `[SUPERVISOR RE-PLAN] You ignored this hint ${count} times. STOP current approach. Create a NEW plan with a DIFFERENT strategy. Do NOT retry the same approach.\n` + hints.join("\n");
    log.warn("supervisor-replan", { tool: toolName, count, key: hintKey });
  } else if (count >= 2) {
    // Level 2: Warning
    hint = `[SUPERVISOR WARNING — repeated] ` + hints.join("\n");
    log.info("supervisor-repeat", { tool: toolName, count, key: hintKey });
  } else {
    // Level 1: Hint
    hint = hints.join("\n");
    log.info("supervisor-hint", { tool: toolName, hints: hints.length, preview: hint.slice(0, 100) });
  }
  return hint;
}

/**
 * Check if agent's text response is a mid-task description instead of action.
 * Called with the model's text response (not tool results).
 * @returns {string|null} hint to inject, or null
 */
export function checkMidTaskDescription(text, hadToolCalls) {
  if (!_enabled || hadToolCalls) return null;
  const lower = (text || "").toLowerCase();
  const descriptionPatterns = [
    /\bi will (now |)(save|create|open|search|find|read|check|run|execute|navigate|download|fetch|write)\b/,
    /\bnow i('ll| will| should| need to)\b/,
    /\bnext i (need to|will|should)\b/,
    /\blet me\b.*\b(first|start|begin)\b/,
    /\bi('m going to|'ll)\b.*\b(save|create|open|search|find|read|check|run|execute)\b/,
    /\bi need to\b.*\b(first|next|then)\b/,
    /\bmy next step\b/, /\bthe next step\b/,
  ];
  const isDescription = descriptionPatterns.some(p => p.test(lower));
  if (isDescription) {
    log.info("mid-task-description", { text: lower.slice(0, 80) });
    return "HINT: Don't describe what you'll do — just call the tools. The user sees your progress through tool activity, not text descriptions.";
  }
  return null;
}

/**
 * Is this tool one that actually looks at the screen?
 *
 * The three dialog rules used to match on the result string alone, with no
 * check that anything was observed. So the word "recover" appearing in a file
 * being read, a test run's output, or a page fetched from the web produced
 * "Document Recovery dialog detected. Press alt+d to DISCARD" — an
 * instruction to press a key that throws work away, triggered by a word in
 * prose. Every other rule in this file already keyed on the tool or its
 * arguments, which is what makes a hint about an action rather than a guess
 * about a word.
 *
 * Only these tools return what is on the screen, so only these can be evidence
 * that a dialog is up. desktop_click and desktop_type are deliberately absent:
 * they act on the screen without reporting it, so their result saying
 * "Recovery" is the model talking, not a screen.
 *
 * The screenbox MCP tools count: they observe the same screen and are a
 * legitimate source of this evidence, so the test is about capability rather
 * than spelling.
 */
function _isScreenObserver(name) {
  if (typeof name !== "string") return false;
  return (
    name === "desktop_look" ||
    name === "desktop_screenshot" ||
    name === "desktop_screenshot_gui" ||
    name === "desktop_shell" ||
    name.startsWith("mcp_screenbox_")
  );
}

/**
 * Detect if a tool call is a write/create/modify action.
 */
function _isWriteAction(name, args) {
  // File write tools
  if (name === "write_file" || name === "edit_file") return true;
  // Shell commands that write
  if (name.includes("shell") || name === "run_command") {
    const cmd = args?.command || "";
    if (cmd.match(/\b(echo|cat|printf|tee)\b.*[>|]/) || cmd.includes(">>")) return true;
    if (cmd.match(/\b(cp|mv|mkdir|touch|curl\s.*-o)\b/)) return true;
    if (cmd.includes("apt-get install") || cmd.includes("pip install")) return true;
  }
  // Desktop: type, key (Ctrl+S = save), clipboard paste
  if (name.includes("type") && (args?.text || "").length > 20) return true;
  if (name.includes("key")) {
    const keys = (args?.keys || args?.key || "").toLowerCase();
    if (keys === "ctrl+s" || keys === "ctrl+shift+s" || keys === "return" || keys === "enter") return true;
  }
  // Chrome: navigate is not write, but type into form + submit is
  if (name.includes("chrome") && args?.action === "eval") return true;
  return false;
}

/**
 * Detect if a tool call verifies a previous write action.
 */
function _isVerifyAction(name, args, prevArgs) {
  // Read file = verify
  if (name === "read_file" || name === "list_directory") return true;
  if (name.includes("glob") || name.includes("search_in_files")) return true;
  // Shell: cat, ls, head, tail, test -f
  if (name.includes("shell") || name === "run_command") {
    const cmd = args?.command || "";
    if (cmd.match(/\b(cat|head|tail|less|wc|ls|test|stat|file|md5sum|sha256sum)\b/)) return true;
    if (cmd.includes("echo $?") || cmd.includes("$?")) return true;
  }
  // Screenshot = visual verify
  if (name.includes("screenshot") || name.includes("look")) return true;
  // Chrome: page_read, page_map = verify
  if (name.includes("chrome")) {
    const action = args?.action || "";
    if (["page_read", "page_map", "view_read", "page_info"].includes(action)) return true;
  }
  // Think = reasoning about result, counts as verify
  if (name === "think") return true;
  return false;
}

function detectApp(toolName, args, result) {
  const resultStr = typeof result === "string" ? result : JSON.stringify(result);
  const cmd = args?.command || args?.action || "";
  // Check tool result content
  if (resultStr.includes("LibreOffice") || resultStr.includes("libreoffice") || resultStr.includes("Calc")) return "libreoffice-calc";
  if (resultStr.includes("Mousepad") || resultStr.includes("mousepad")) return "mousepad";
  if (resultStr.includes("Chrome") || resultStr.includes("Chromium") || resultStr.includes("chrome")) return "chrome";
  if (resultStr.includes("GIMP") || resultStr.includes("gimp")) return "gimp";
  if (resultStr.includes("Thunar") || resultStr.includes("thunar")) return "file-manager";
  if (resultStr.includes("Terminal") || resultStr.includes("terminal")) return "terminal";
  // Check command content
  if (cmd.includes("mousepad")) return "mousepad";
  if (cmd.includes("soffice") || cmd.includes("libreoffice")) return "libreoffice-calc";
  if (cmd.includes("chromium") || cmd.includes("chrome")) return "chrome";
  if (cmd.includes("gimp")) return "gimp";
  // Check tool name for desktop tools
  if (toolName.includes("chrome")) return "chrome";
  return null;
}

/**
 * Conditional reflection — triggers only when context is at risk.
 * Replaces always-on mandatory reflection. Fires on:
 *   - Large tool result (>3k chars) — model likely to lose focus
 *   - Error in last tool — model needs to reconsider approach
 *   - 5+ tool calls without reflection — periodic checkpoint
 *
 * @param {object} opts - { lastToolResult, lastToolName, apiCallCount, planStep }
 * @returns {string|null} reflection message or null
 */
let _callsSinceReflection = 0;

export function evaluateReflection({ lastToolResult, lastToolName, apiCallCount, planStep }) {
  if (!_enabled) return null;
  _callsSinceReflection++;

  const resultSize = (lastToolResult || "").length;
  const isError = (lastToolResult || "").includes("error") || (lastToolResult || "").includes("Error");
  const isLargeResult = resultSize > 3000;
  const needsCheckpoint = _callsSinceReflection >= 5;

  // Check if agent is repeating same action (stuck).
  // Bug fix 2026-04-12: previously only checked name, firing "repeated action"
  // reflections on every legitimate sequential multi-file read. Now requires
  // BOTH same name AND same args — real stuck behavior, not busy work.
  let isStuck = false;
  if (_lastTools.length >= 2) {
    const [a, b] = [_lastTools[_lastTools.length - 2], _lastTools[_lastTools.length - 1]];
    if (a.name === b.name) {
      try {
        isStuck = JSON.stringify(a.args || {}) === JSON.stringify(b.args || {});
      } catch { isStuck = false; }
    }
  }

  if (!isLargeResult && !isError && !needsCheckpoint && !isStuck) return null;

  _callsSinceReflection = 0;

  const trigger = isStuck ? "repeated action" : isLargeResult ? "large result" : isError ? "error" : "checkpoint";
  const summary = resultSize > 200 ? lastToolResult.slice(0, 200) + "..." : lastToolResult || "none";

  log.info("reflection-triggered", { trigger, tool: lastToolName, resultSize });

  // Extract EXPECT from previous assistant message if present
  const expectMatch = _lastExpect;
  const evalLine = expectMatch
    ? `Your EXPECT was: "${expectMatch}". Did the result match? If not — your action failed. Change approach.`
    : "Did your last action achieve its goal? Check the result carefully.";

  const question = isStuck
    ? "You repeated the same action. The state did NOT change. Try a DIFFERENT tool or method."
    : evalLine;

  const parts = [
    `[REFLECTION — ${trigger}]`,
    `Last: ${lastToolName} (${resultSize} chars)`,
    planStep || "",
    question,
  ].filter(Boolean);

  return parts.join("\n");
}

/**
 * Track EXPECT from assistant's text response.
 * Called from agent.js when assistant returns text + tool calls.
 */
export function trackExpect(assistantText) {
  if (!assistantText) return;
  const match = assistantText.match(/EXPECT:\s*(.+?)(?:\n|$)/i);
  _lastExpect = match ? match[1].trim() : null;
}

export function resetSupervisor() {
  _lastTools = [];
  _hintCounts = {};
  _callsSinceReflection = 0;
  _lastExpect = null;
}
