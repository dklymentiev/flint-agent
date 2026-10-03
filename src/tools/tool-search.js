// tool_search: a small core set every turn, everything else found by meaning.
//
// The classifier used to pick the tools for each turn, and on 2026-09-26 its
// picks cost three of Flint's five losses: no web on a repair task, every tool
// taken away from an explicit delete, write_file alone for "make a Word
// document", three operator tools for a browser task. A guess made before the
// model has read the request should not decide what the model can do.
//
// Here the model always has the core it needs for most work, and when it needs
// something else (a browser, a remote desktop, mail, the planner) it asks for
// it by describing the job. What it finds stays loaded for the rest of the
// session. Flint had a regex version of this,
// find_tools, until the classifier replaced it on 2026-04-04, unmeasured.

// Always in the payload. Files, a shell, processes and the web cover most of
// what a user asks for; the rest is one search away.
export const CORE_TOOLS = [
  "read_file", "write_file", "edit_file", "list_directory", "search_in_files", "glob",
  "create_directory", "delete_file", "move_file", "copy_file", "view_image",
  "run_command", "run_background_command", "peek_process", "kill_process", "list_processes",
  "web_search", "web_fetch", "think",
];

export const TOOL_SEARCH_NAME = "tool_search";

export const toolSearchDef = {
  type: "function",
  function: {
    name: TOOL_SEARCH_NAME,
    description:
      "Find more tools by describing what you need to do, e.g. 'open a page in a browser and click', " +
      "'control a remote desktop', 'send an email', 'search my memory notes', 'create a task in the planner'. " +
      "The tools it returns become available immediately and stay available for the rest of the session. " +
      "Use it when none of your current tools can do the job.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "What you need to do, in plain words" },
        limit: { type: "number", description: "How many tools to return (default 6, max 15)" },
      },
      required: ["query"],
    },
  },
};

/** Tool names shown per MCP server in the catalog before "+N more". */
export const CATALOG_NAMES_PER_SERVER = 4;

/**
 * What tool_search can load, by MCP server: "screenbox: desktop_screenshot,
 * desktop_click, desktop_chrome, desktop_type, +19 more". Tools already in
 * hand are left out. Empty when every MCP tool is in hand.
 *
 * Owner, 2026-10-02: with the classifier off the model was handed the built-in
 * tools only, and an operator who had connected Screenbox got an agent that
 * said it had no Screenbox tools. Hiding them saves tokens; not saying they
 * exist cost the task. The catalog is a line per server, not their schemas.
 */
export function mcpCatalog(allDefs, inHandNames = []) {
  const inHand = new Set(inHandNames);
  const servers = new Map();
  for (const t of allDefs || []) {
    const name = nameOf(t);
    const m = name.match(/^mcp_([A-Za-z0-9-]+?)_(.+)$/);
    if (!m || inHand.has(name)) continue;
    if (!servers.has(m[1])) servers.set(m[1], []);
    servers.get(m[1]).push(m[2]);
  }
  return [...servers].map(([server, names]) => {
    const shown = names.slice(0, CATALOG_NAMES_PER_SERVER).join(", ");
    const more = names.length > CATALOG_NAMES_PER_SERVER ? `, +${names.length - CATALOG_NAMES_PER_SERVER} more` : "";
    return `- ${server}: ${shown}${more}`;
  }).join("\n");
}

/** tool_search's definition with the catalog of what it can load appended. */
export function toolSearchDefWith(catalog) {
  if (!catalog) return toolSearchDef;
  return {
    ...toolSearchDef,
    function: {
      ...toolSearchDef.function,
      description: toolSearchDef.function.description +
        "\n\nConnected tool servers whose tools are not loaded yet (search by the tool or server name, " +
        "e.g. 'screenbox desktop_chrome'):\n" + catalog,
    },
  };
}

// Loaded by a search in this process. One Flint process is one session.
const loaded = new Set();

export function loadedToolNames() {
  return [...loaded];
}

export function resetLoadedTools() {
  loaded.clear();
}

// Tools that arrived by a plugin install or reload are in hand at once, the
// way a search's finds are: the model asked for them by installing.
export function markLoaded(names) {
  for (const n of names || []) if (n) loaded.add(n);
}

function nameOf(t) {
  return t.function?.name || t.name || "";
}

// Words, lowercased, with snake_case and camelCase split, so "desktop_click"
// matches "click on the desktop".
function tokens(text) {
  return String(text || "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1);
}

const STOP = new Set(["the", "and", "for", "with", "to", "of", "in", "on", "an", "or", "my", "me", "it", "is", "at", "by", "from", "this", "that", "use", "do", "need"]);

/**
 * Rank tools against a plain-words query.
 *
 * Name words count three times description words: a tool's name is the
 * shortest honest statement of what it does. A crude stem (drop a trailing s,
 * ing, ed) lets "clicking" meet "click". Ties keep registry order.
 *
 * @returns {Array} tool definitions, best first
 */
export function rankTools(query, candidates, limit = 6) {
  const stem = (w) => w.replace(/(ing|ed|es|s)$/, "") || w;
  const q = tokens(query).filter((w) => !STOP.has(w)).map(stem);
  if (!q.length) return [];
  const scored = candidates.map((t, i) => {
    const name = tokens(nameOf(t)).map(stem);
    const desc = tokens(t.function?.description).map(stem);
    let score = 0;
    for (const w of q) {
      if (name.includes(w)) score += 3;
      if (desc.includes(w)) score += 1;
    }
    return { t, i, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, Math.max(1, Math.min(15, limit)))
    .map((s) => s.t);
}

/**
 * The handler. Searches everything registered that is not already in hand,
 * loads the matches, and says what they are.
 *
 * @param {Function} getAll returns every registered tool definition
 */
export function createToolSearchHandler(getAll) {
  return function toolSearch({ query, limit = 6 } = {}) {
    const inHand = new Set([...CORE_TOOLS, ...loaded, TOOL_SEARCH_NAME]);
    const pool = getAll().filter((t) => !inHand.has(nameOf(t)));
    const found = rankTools(query, pool, limit);
    if (!found.length) {
      return `No tools matched "${query}". Try other words for the job, or do it with the tools you have.`;
    }
    for (const t of found) loaded.add(nameOf(t));
    const lines = found.map((t) => `- ${nameOf(t)}: ${(t.function?.description || "").split("\n")[0].slice(0, 160)}`);
    return `Loaded ${found.length} tool(s), available now:\n${lines.join("\n")}`;
  };
}
