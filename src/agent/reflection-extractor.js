// Extract a reflection from a session transcript using an LLM call.
//
// Prompts the model with 3 questions — what did I do, what did I do wrong,
// how can I do better — and parses the structured response.
//
// Part of Layer 1 memory architecture.

import { chatCompletion } from "../api/client.js";
import { appendReflection } from "../memory/reflections.js";
import { createLogger } from "../logging/logger.js";

const log = createLogger("reflection");

const EXTRACTION_SYSTEM = `You are a self-reflection analyzer for an AI agent.

Given a session transcript, answer three questions about the AGENT'S behavior (not the user's):

1. DID — What did the agent do this session? One concise sentence.
2. WRONG — What did the agent do wrong or suboptimally? Up to 5 bullet points. Each must be CONCRETE and ACTIONABLE (e.g. "used python3 on Windows where it's unavailable" not "had trouble with tools"). If nothing went wrong, use empty list.
3. BETTER — How should the agent behave next time to avoid those mistakes? Up to 5 bullet points. Each must be a specific actionable rule the agent can follow next time.

Output ONLY valid JSON matching this schema, no other text:
{"did": "one sentence", "wrong": ["point1", "point2"], "better": ["rule1", "rule2"], "tags": ["tag1", "tag2"]}

Tags are short keywords (e.g. "verbosity", "tool-choice", "file-ops", "consistency", "windows-paths").

If the session was trivial or empty (no real agent action), output:
{"did": "", "wrong": [], "better": [], "tags": []}
— this will be discarded.`;

/**
 * Extract a reflection from a session transcript.
 * @param {Array} messages — array of {role, content} message objects
 * @param {string} sessionId — session id to tag the reflection with
 * @param {object} opts — { signal?, maxTranscriptChars? }
 * @returns {Promise<string|null>} id of appended reflection, or null if discarded/failed
 */
export async function extractAndStoreReflection(messages, sessionId, opts = {}) {
  const maxChars = opts.maxTranscriptChars || 12000;
  const transcript = buildTranscript(messages, maxChars);

  // Skip if session too short to be meaningful
  if (transcript.length < 100) {
    log.debug("reflection-skipped", { reason: "transcript too short", sessionId, chars: transcript.length });
    return null;
  }

  try {
    const extractionMessages = [
      { role: "system", content: EXTRACTION_SYSTEM },
      { role: "user", content: `Session transcript:\n\n${transcript}\n\nExtract the reflection. JSON only, no preamble.` },
    ];

    const result = await chatCompletion(extractionMessages, [], null, {
      signal: opts.signal,
      source: "extractor",
    });
    const text = result?.text || result?.message?.content || "";

    const parsed = parseReflectionJson(text);
    if (!parsed) {
      log.warn("reflection-parse-failed", { sessionId, rawLen: text.length });
      return null;
    }

    // Discard if empty (model decided nothing to reflect on)
    if (!parsed.did && parsed.wrong.length === 0 && parsed.better.length === 0) {
      log.info("reflection-empty", { sessionId });
      return null;
    }

    const id = appendReflection({
      session_id: sessionId,
      did: parsed.did,
      wrong: parsed.wrong,
      better: parsed.better,
      tags: parsed.tags,
    });
    log.info("reflection-stored", { sessionId, id, wrong: parsed.wrong.length, better: parsed.better.length });
    return id;
  } catch (e) {
    log.warn("reflection-failed", { sessionId, error: e.message });
    return null;
  }
}

/**
 * Build a compact transcript from the message array. Strips system messages,
 * trims tool outputs, caps total length.
 */
function buildTranscript(messages, maxChars) {
  const out = [];
  for (const m of messages || []) {
    if (m.role === "system") continue;
    const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content || "");
    if (!content.trim()) continue;
    // Trim long tool results
    const trimmed = content.length > 500 ? content.slice(0, 400) + "... [truncated]" : content;
    const tool_calls = Array.isArray(m.tool_calls) ? m.tool_calls.map(t => t.function?.name || t.name).filter(Boolean) : [];
    const prefix = tool_calls.length ? `[${m.role}, used: ${tool_calls.join(",")}]` : `[${m.role}]`;
    out.push(`${prefix} ${trimmed}`);
  }
  let transcript = out.join("\n");
  if (transcript.length > maxChars) {
    // Keep head and tail — middle of long sessions is least interesting
    const head = transcript.slice(0, Math.floor(maxChars * 0.4));
    const tail = transcript.slice(-Math.floor(maxChars * 0.5));
    transcript = head + "\n\n... [middle truncated] ...\n\n" + tail;
  }
  return transcript;
}

/**
 * Extract the JSON object from a model response that may have extra text around it.
 */
function parseReflectionJson(text) {
  if (!text) return null;
  // Try direct parse
  try {
    return normalize(JSON.parse(text.trim()));
  } catch {}
  // Find first { ... } block
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return normalize(JSON.parse(m[0]));
  } catch {
    return null;
  }
}

function normalize(obj) {
  if (!obj || typeof obj !== "object") return null;
  return {
    did: typeof obj.did === "string" ? obj.did : "",
    wrong: Array.isArray(obj.wrong) ? obj.wrong.map(String).filter(s => s.trim()) : [],
    better: Array.isArray(obj.better) ? obj.better.map(String).filter(s => s.trim()) : [],
    tags: Array.isArray(obj.tags) ? obj.tags.map(String).filter(s => s.trim()) : [],
  };
}
