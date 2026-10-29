// --tools and --disallowedTools: which tools a host lets this agent have.
//
// The meaning is Claude Code's, so a host can give both agents one list:
// --tools names the only tools there are, --disallowedTools takes tools away,
// and a tool taken away is neither offered to the model nor run. (Claude
// Code's --allowedTools means "run without asking" and narrows nothing; Flint
// accepts it and ignores it.) The registry applies the result in one place,
// for the list, tool_search and the call (registry.js setToolFilter).
//
// Names may be Flint's (read_file, mcp_messaging_send), Claude Code's built-in
// ones (Read, Bash, WebSearch) or Claude Code's MCP form: mcp__messaging for a
// whole server, mcp__messaging__send for one tool. A rule in parentheses,
// Bash(git *), applies to the whole tool here.

import { TOOL_NAME_SYNONYMS } from "./permissions.js";

// Claude Code built-in names the synonym table does not already cover.
const CLAUDE_CODE_NAMES = { websearch: "web_search", webfetch: "web_fetch", multiedit: "edit_file" };

function listOf(value) {
  return String(value || "").split(/[\s,]+/).map((s) => s.replace(/\(.*$/, "").trim()).filter(Boolean);
}

// One entry as a test on a Flint tool name.
function matcher(entry) {
  const mcp = entry.match(/^mcp__(.+?)(?:__(.+))?$/);
  if (mcp) return mcp[2] ? (n) => n === `mcp_${mcp[1]}_${mcp[2]}` : (n) => n.startsWith(`mcp_${mcp[1]}_`);
  const lower = entry.toLowerCase();
  const flint = TOOL_NAME_SYNONYMS[lower] || CLAUDE_CODE_NAMES[lower] || entry;
  return (n) => n === flint;
}

/**
 * The host's tool flags as a test on a tool name, or null when there are none
 * (every tool stays). An empty --tools, as in Claude Code, leaves no tools.
 * @param {{tools?: string|null, disallowedTools?: string|null}} flags
 */
export function toolFilterFrom({ tools = null, disallowedTools = null } = {}) {
  const allow = listOf(tools).map(matcher);
  const deny = listOf(disallowedTools).map(matcher);
  if (tools == null && !deny.length) return null;
  return (name) => (tools == null || allow.some((m) => m(name))) && !deny.some((m) => m(name));
}
