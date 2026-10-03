// Context compression with configurable threshold
// Only compresses when total context exceeds config.compressAfterTokens
//
// Levels (when compression IS triggered):
//   Current iteration: full results
//   Previous iteration (age=1): head/tail truncation
//   Older iterations (age>=2): one-line type-aware summary
//
// Facts extracted SYNCHRONOUSLY before summarizing (await, not fire-and-forget)
// Action log: deterministic tracking of side-effect tools

import { getSpendLevel, spendSettings, windowShare } from "../spend.js";
import { extractFacts } from "../memory/extract-facts.js";
import { saveSessionFacts, saveSessionFact } from "../memory/session-facts.js";
import { config } from "../config.js";
import { contextWindow } from "./usage.js";
import { createLogger } from "../logging/logger.js";

const log = createLogger("compression");

const COMPRESS_THRESHOLD = config.compressThreshold;
const HEAD_LINES = 8;
const TAIL_LINES = 3;

// Tools that change state — tracked as action facts
const SIDE_EFFECT_TOOLS = new Set([
  "write_file", "edit_file", "delete_file", "copy_file", "move_file", "create_directory",
  "run_command", "run_background_command",
]);

// MCP tool patterns that indicate side effects
const MCP_SIDE_EFFECT_PATTERNS = [
  /desktop_click/, /desktop_type/, /desktop_key/, /desktop_shell/,
  /desktop_batch/, /desktop_manage/, /desktop_chrome.*navigate/,
  /desktop_file/, /gmail_send/, /mesh_add/,
];

function isSideEffectTool(toolName, toolArgs) {
  if (SIDE_EFFECT_TOOLS.has(toolName)) return true;
  for (const pat of MCP_SIDE_EFFECT_PATTERNS) {
    if (pat.test(toolName)) return true;
  }
  // desktop_chrome with action=navigate, type, click
  if (toolName.includes("desktop_chrome")) {
    const action = toolArgs?.action || "";
    if (["navigate", "type", "click", "new_tab", "close_tab"].includes(action)) return true;
  }
  return false;
}

/**
 * Generate a short action description from a tool call
 */
function describeAction(toolName, toolArgs, result) {
  const shortResult = typeof result === "string" ? result.slice(0, 100) : "";

  if (toolName === "write_file" || toolName === "edit_file") {
    return `Modified file: ${toolArgs?.path || "?"}`;
  }
  if (toolName === "run_command") {
    const cmd = (toolArgs?.command || "?").slice(0, 60);
    return `Ran command: ${cmd}`;
  }
  if (toolName.includes("desktop_click")) {
    return `Clicked at (${toolArgs?.x}, ${toolArgs?.y})`;
  }
  if (toolName.includes("desktop_shell")) {
    const cmd = (toolArgs?.command || "?").slice(0, 60);
    return `Desktop shell: ${cmd}`;
  }
  if (toolName.includes("desktop_batch")) {
    const count = toolArgs?.actions?.length || toolArgs?.action_count || "?";
    return `Desktop batch: ${count} actions`;
  }
  if (toolName.includes("desktop_chrome")) {
    const action = toolArgs?.action || "?";
    const url = toolArgs?.url || "";
    return url ? `Chrome ${action}: ${url.slice(0, 60)}` : `Chrome ${action}`;
  }
  if (toolName.includes("desktop_manage")) {
    const action = toolArgs?.action || "?";
    const app = toolArgs?.app || "";
    return app ? `Desktop ${action}: ${app}` : `Desktop ${action}`;
  }
  if (toolName.includes("desktop_type")) {
    return `Typed text (${toolArgs?.text?.length || "?"} chars)`;
  }
  if (toolName.includes("desktop_key")) {
    return `Pressed: ${toolArgs?.keys || "?"}`;
  }
  return `${toolName}(${JSON.stringify(toolArgs).slice(0, 80)})`;
}

export function summarizeToolResult(content, toolName, toolArgs) {
  const lines = content.split("\n");
  const chars = content.length;
  const firstLine = lines[0]?.slice(0, 80) || "";

  switch (toolName) {
    case "read_file": {
      const filePath = toolArgs?.path || "unknown";
      return `[Read ${filePath} (${lines.length} lines, ${chars} chars): ${firstLine}...]`;
    }
    case "list_directory": {
      const dirPath = toolArgs?.path || "unknown";
      const itemCount = lines.length;
      const preview = lines.slice(0, 3).join(", ");
      const more = itemCount > 3 ? ` +${itemCount - 3} more` : "";
      return `[Listed ${dirPath}: ${itemCount} items — ${preview}${more}]`;
    }
    case "run_command": {
      const cmd = toolArgs?.command || "unknown";
      const cmdShort = cmd.length > 40 ? cmd.slice(0, 40) + "..." : cmd;
      const exitMatch = content.match(/exit(?:ed| code)[:\s]*(\d+)/i);
      const exitCode = exitMatch ? exitMatch[1] : "?";
      return `[Ran '${cmdShort}' (exit ${exitCode}, ${lines.length} lines): ${firstLine}...]`;
    }
    case "search_in_files": {
      const pat = toolArgs?.pattern || "?";
      const matchCount = lines.length - 1;
      const files = new Set(lines.slice(1).map(l => l.split(":")[0]).filter(Boolean));
      return `[Search /${pat}/: ${matchCount} matches in ${files.size} files — ${[...files].slice(0, 5).join(", ")}${files.size > 5 ? " +" + (files.size - 5) + " more" : ""}]`;
    }
    case "think": {
      return `[Thought: ${firstLine}...]`;
    }
    default: {
      return `[${toolName}(...) → ${lines.length} lines, ${chars} chars: ${firstLine}...]`;
    }
  }
}

function compressHeadTail(content) {
  const originalLen = content.length;
  const lines = content.split("\n");
  if (lines.length > HEAD_LINES + TAIL_LINES + 2) {
    const head = lines.slice(0, HEAD_LINES).join("\n");
    const tail = lines.slice(-TAIL_LINES).join("\n");
    const omitted = lines.length - HEAD_LINES - TAIL_LINES;
    return `${head}\n[... ${omitted} lines omitted, ${originalLen} chars total ...]\n${tail}`;
  }
  return content.slice(0, COMPRESS_THRESHOLD) + `\n[... truncated, ${originalLen} chars total]`;
}

/**
 * Estimate token count from messages (rough: 1 token ≈ 4 chars)
 */
function estimateTokens(messages) {
  let total = 0;
  for (const m of messages) {
    const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content || "");
    total += Math.ceil(content.length / 4);
    if (m.tool_calls) {
      for (const tc of m.tool_calls) {
        total += Math.ceil((tc.function?.arguments || "").length / 4) + 10;
      }
    }
  }
  return total;
}

/**
 * When history may be rewritten to make room, in tokens.
 *
 * Half the model's window, capped at 128k because a bigger
 * prompt is paid for on every call even when cached; 64k when the window is
 * unknown. COMPRESS_AFTER_TOKENS overrides. On the 2026-09-26 auto-budget run
 * the old fixed point (25k for the eager pass) collapsed sixteen file reads
 * into one-liners at call 16 and again every few calls after; the agent never
 * edited anything, it re-read. Room is not the problem at 25k on any current
 * model, forgetting is.
 */
export function compressThreshold() {
  if (config.compressAfterTokens) return config.compressAfterTokens;
  return compressThresholdFor(contextWindow(), getSpendLevel());
}

/** The threshold for a window (null: unknown) at a spend level (spend.js). */
export function compressThresholdFor(window, level) {
  return windowShare(spendSettings(level).compress, window);
}

/**
 * compressContext — threshold-based, sync fact extraction, action logging
 *
 * @param {Array} messages
 * @param {number} prevIterationStart
 * @param {number} iterationStart
 * @param {string} [sessionId]
 * @returns {Promise<number>} tokens saved
 */
export async function compressContext(messages, prevIterationStart, iterationStart, sessionId, { forceCompress = false } = {}) {
  const estimatedTokens = estimateTokens(messages);
  const threshold = compressThreshold();

  // === Action logging (always, regardless of compression threshold) ===
  // Track side-effect tools as session facts for context preservation
  if (sessionId) {
    for (let i = prevIterationStart; i < iterationStart; i++) {
      const m = messages[i];
      if (m.role === "assistant" && m.tool_calls) {
        for (const tc of m.tool_calls) {
          const name = tc.function?.name;
          let args;
          try { args = JSON.parse(tc.function?.arguments || "{}"); } catch { args = {}; }

          if (isSideEffectTool(name, args)) {
            // Find corresponding tool result
            const resultMsg = messages.find((rm, ri) =>
              ri > i && rm.role === "tool" && rm.tool_call_id === tc.id
            );
            const resultText = resultMsg?.content || "";
            const actionDesc = describeAction(name, args, resultText);

            saveSessionFact(sessionId, {
              content: actionDesc,
              category: "action",
              source: "action-log",
            });
            log.debug("action-logged", { tool: name, action: actionDesc });
          }
        }
      }
    }
  }

  // === Check threshold — skip compression if under budget ===
  if (!forceCompress && estimatedTokens < threshold) {
    log.debug("compression-skipped", { estimatedTokens, threshold });
    return 0;
  }

  log.info("compression-triggered", { estimatedTokens, threshold, messages: messages.length });

  let saved = 0;
  const messagesToExtract = [];

  for (let i = 0; i < iterationStart; i++) {
    const m = messages[i];

    // Replace previous iteration images with existing text description
    // No vision API call — use the OCR/caption text already in the adjacent tool result message.
    // Only the LAST image in context stays as full base64 (current iteration).
    if (m._isImage && Array.isArray(m.content) && m.content.some((c) => c.type === "image_url")) {
      if (!m._compressed) {
        const toolName = m._imageTool || "unknown";
        const imagePath = m._imagePath || null;
        // Use existing text from the image message itself (already has OCR/caption)
        const textBlock = m.content.find((c) => c.type === "text");
        const description = textBlock?.text || "[Previously viewed screenshot]";
        const ref = imagePath ? ` [file: ${imagePath}]` : "";
        m.content = `[Image from ${toolName}${ref}: ${description}]`;
        m._compressed = true;
        saved += 50000; // approximate base64 size saved
        log.info("image-replaced", { tool: toolName, descLen: description.length });
      }
      continue;
    }

    // Collect uncompressed old messages for fact extraction
    const isOld = i < prevIterationStart; // age >= 2
    if (isOld && m.role === "tool" && m._compressed !== "summary") {
      messagesToExtract.push(m);
    }
    if (isOld && (m.role === "user" || m.role === "assistant") && !m._compressed) {
      messagesToExtract.push(m);
    }

    if (m.role !== "tool") continue;
    if (m._compressed === "summary") continue;

    if (!isOld && m.content.length <= COMPRESS_THRESHOLD) continue;

    const originalLen = m.content.length;

    if (isOld) {
      m.content = summarizeToolResult(m.content, m._toolName, m._toolArgs);
      m._compressed = "summary";
    } else if (m._compressed !== "headtail") {
      m.content = compressHeadTail(m.content);
      m._compressed = "headtail";
    }

    saved += originalLen - m.content.length;
  }

  // Mark user/assistant old messages as compressed
  for (let i = 0; i < prevIterationStart; i++) {
    const m = messages[i];
    if ((m.role === "user" || m.role === "assistant") && !m._compressed) {
      m._compressed = true;
    }
  }

  // Extract facts SYNCHRONOUSLY before they're lost
  if (sessionId && messagesToExtract.length > 0) {
    try {
      const facts = await extractFacts(messagesToExtract);
      if (facts.length > 0) {
        saveSessionFacts(sessionId, facts);
        log.info("facts-extracted", { count: facts.length, facts: facts.map(f => f.content.slice(0, 60)) });
      }
    } catch (err) {
      log.warn("fact-extraction-failed", { error: err.message });
    }
  }

  log.info("compression-done", { saved, estimatedAfter: estimateTokens(messages) });
  return saved;
}
