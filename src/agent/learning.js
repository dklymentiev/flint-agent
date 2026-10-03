/**
 * Learning System — extract facts & patterns from completed tasks
 *
 * After successful task completion:
 * 1. Analyze tool call sequence
 * 2. Extract reusable patterns (e.g. "search → read → save → open")
 * 3. Extract facts (e.g. "desktop_shell works for remote file creation")
 * 4. Store via knowledge.js
 *
 * No LLM calls — pure code extraction from action history.
 */

import { store as storeKnowledge, retrieve } from "./knowledge.js";
import { createLogger } from "../logging/logger.js";

const log = createLogger("learning");

/**
 * Extract learnings from a completed task.
 * @param {object} opts
 * @param {Array} opts.messages - conversation messages from agent loop
 * @param {string} opts.task - original task description
 * @param {object} opts.plan - completed plan (goal + tasks)
 * @param {string} opts.outcome - "success" | "partial" | "failed"
 */
export function extractLearnings({ messages, task, plan, outcome }) {
  if (outcome === "failed") return; // don't learn from failures (yet)

  const toolCalls = _extractToolSequence(messages);
  if (toolCalls.length < 2) return; // nothing to learn from 1 tool call

  // Check if we already know this pattern
  const existing = retrieve(task, 1);
  if (existing.length > 0 && existing[0].score > 2) {
    log.info("pattern-already-known", { task: task.slice(0, 40) });
    return;
  }

  // Extract pattern: ordered sequence of unique tool names
  const pattern = _buildPattern(toolCalls, task);
  if (pattern) {
    storeKnowledge(pattern);
    log.info("pattern-stored", { type: pattern.type, text: pattern.text.slice(0, 60) });
  }

  // Extract facts: tools that worked in specific contexts
  const facts = _buildFacts(toolCalls, task);
  for (const fact of facts) {
    storeKnowledge(fact);
    log.info("fact-stored", { text: fact.text.slice(0, 60) });
  }
}

/**
 * Extract tool call sequence from messages.
 */
function _extractToolSequence(messages) {
  const calls = [];
  for (const m of messages) {
    if (m.role === "assistant" && m.tool_calls) {
      for (const tc of m.tool_calls) {
        const name = tc.function?.name || "unknown";
        let args = {};
        try { args = JSON.parse(tc.function?.arguments || "{}"); } catch {}
        calls.push({ name, args });
      }
    }
  }
  return calls;
}

/**
 * Build a reusable pattern from tool sequence.
 */
function _buildPattern(toolCalls, task) {
  // Deduplicate consecutive same-tool calls
  const steps = [];
  let prev = null;
  for (const tc of toolCalls) {
    const shortName = _shortToolName(tc.name);
    if (shortName !== prev) {
      steps.push(shortName);
      prev = shortName;
    }
  }

  if (steps.length < 2 || steps.length > 15) return null;

  // Extract task keywords for triggers
  const triggers = task.toLowerCase()
    .split(/\s+/)
    .filter(w => w.length > 3)
    .filter(w => !["this", "that", "then", "with", "from", "using", "into", "open", "the"].includes(w))
    .slice(0, 5);

  return {
    type: "pattern",
    text: `For "${_summarizeTask(task)}": ${steps.join(" → ")}`,
    context: task.slice(0, 100),
    triggers,
    confidence: 0.6,
    steps,
  };
}

/**
 * Build facts from tool usage in context.
 */
function _buildFacts(toolCalls, task) {
  const facts = [];
  const seen = new Set();

  for (const tc of toolCalls) {
    const shortName = _shortToolName(tc.name);

    // Fact: MCP tool used for file operation
    if (tc.name.includes("mcp_") && tc.args?.command && tc.args.command.includes("echo")) {
      const key = "remote-echo";
      if (!seen.has(key)) {
        seen.add(key);
        facts.push({
          type: "fact",
          text: `Use ${shortName} (remote shell) for file creation on remote systems, not local write_file`,
          context: "remote file operations",
          triggers: ["file", "save", "create", "remote", "desktop"],
          confidence: 0.7,
        });
      }
    }

    // Fact: successful tool for reading web content
    if (tc.name.includes("chrome") && tc.args?.action === "page_read") {
      const key = "chrome-read";
      if (!seen.has(key)) {
        seen.add(key);
        facts.push({
          type: "fact",
          text: `Use chrome page_read for extracting web page content (faster than screenshot+OCR)`,
          context: "web content extraction",
          triggers: ["read", "page", "content", "extract", "web"],
          confidence: 0.8,
        });
      }
    }
  }

  return facts;
}

/**
 * Shorten tool name: mcp_screenbox_desktop_shell → desktop_shell
 */
function _shortToolName(name) {
  if (name.startsWith("mcp_")) {
    const parts = name.split("_");
    return parts.slice(2).join("_") || name;
  }
  return name;
}

/**
 * Summarize task to ~30 chars.
 */
function _summarizeTask(task) {
  if (task.length <= 30) return task;
  return task.slice(0, 27) + "...";
}

/**
 * True if a tool result looks like a genuine failure. Matches structural
 * failure markers (non-zero exit, "Error:" prefix, permission/path errors)
 * -- deliberately NOT the bare word "error", which appears in legitimate
 * content like a command string or a README about error handling.
 *
 * Shared with agent.js's failure-recovery gate so both use one definition.
 */
export function isFailureResult(content) {
  if (typeof content !== "string") return false;
  return /error\s*\(exit|\berror:|\berror executing\b|\(exit\s+[1-9]|exit\s+code\s+[1-9]|exit\s+status\s+[1-9]|\bpermission denied\b|\bno such file\b|\bcommand not found\b|\bfailed to\b|\beconnrefused\b|\beconnreset\b|\benoent\b|\beacces\b|traceback \(most recent/i.test(content);
}
