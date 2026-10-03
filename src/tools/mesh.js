import { config } from "../config.js";

const MEMORY_URL = config.memoryUrl;

async function meshFetch(path, opts = {}) {
  const url = `${MEMORY_URL}${path}`;
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json", ...opts.headers },
    ...opts,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Mesh API ${res.status}: ${text}`);
  }
  return res.json();
}

export const tools = [
  {
    type: "function",
    function: {
      name: "mesh_search",
      description:
        "Semantic search across all documents in Mesh memory. " +
        "Finds documents by meaning, not exact words. " +
        "Use this to recall past decisions, worklogs, notes, and any saved knowledge.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "What to search for (natural language)" },
          limit: { type: "number", description: "Max results (default 5)" },
          tags: {
            type: "array",
            items: { type: "string" },
            description: "Optional tag filter, e.g. ['type:worklog', 'guid:mesh-api']",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "mesh_add",
      description:
        "Save a document to Mesh memory. Auto-tags (date, source) are added automatically. " +
        "Type and project tags are inferred from similar documents. " +
        "Use this to remember important information, decisions, worklogs, research results.",
      parameters: {
        type: "object",
        properties: {
          content: { type: "string", description: "Document text (min 10 chars)" },
          tags: {
            type: "array",
            items: { type: "string" },
            description: "Optional tags, e.g. ['type:worklog', 'guid:my-project']",
          },
        },
        required: ["content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "mesh_recent",
      description: "Get recent documents from Mesh memory.",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Max documents (default 5)" },
          type: { type: "string", description: "Filter by type: worklog, note, decision, research, etc." },
        },
      },
    },
  },
];

export const handlers = {
  async mesh_search({ query, limit = 5, tags }) {
    const body = { query, limit };
    if (tags?.length) body.tags = tags;
    const data = await meshFetch("/search", {
      method: "POST",
      body: JSON.stringify(body),
    });
    const results = data.results || [];
    if (!results.length) return `No results found for: ${query}`;
    const lines = [`Found ${results.length} results for "${query}":\n`];
    for (const r of results) {
      const score = (r.similarity_score || 0).toFixed(3);
      const date = (r.created_at || "").slice(0, 10);
      const tags = (r.tags || []).join(", ");
      const preview = (r.content || "").slice(0, 200);
      lines.push(`[${r.guid}] score=${score} date=${date}`);
      lines.push(`  tags: ${tags}`);
      lines.push(`  ${preview}`);
      lines.push("");
    }
    return lines.join("\n");
  },

  async mesh_add({ content, tags }) {
    const body = { content, source: "flint" };
    if (tags?.length) body.tags = tags;
    const data = await meshFetch("/", {
      method: "PUT",
      body: JSON.stringify(body),
    });
    const finalTags = (data.tags || []).join(", ");
    return (
      `Document saved: ${data.guid}\n` +
      `Tags: ${finalTags}\n` +
      `Auto-tagging will infer additional tags from similar documents.`
    );
  },

  async mesh_recent({ limit = 5, type } = {}) {
    const params = new URLSearchParams({ limit: String(limit) });
    if (type) params.set("tag", `type:${type}`);
    const data = await meshFetch(`/?${params}`);
    if (!Array.isArray(data) || !data.length) return "No documents found.";
    const lines = [`Recent ${data.length} documents:\n`];
    for (const doc of data) {
      const date = (doc.created_at || "").slice(0, 10);
      const tags = (doc.tags || []).join(", ");
      const preview = (doc.content || "").slice(0, 120);
      lines.push(`[${doc.guid}] ${date} [${tags}]`);
      lines.push(`  ${preview}`);
      lines.push("");
    }
    return lines.join("\n");
  },
};
