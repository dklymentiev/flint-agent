import { insertMemory, searchMemories, getMemory, listRecentMemories, deleteMemory } from "./store.js";
import { updateMemoryMd } from "./markdown.js";
import { createSkill, updateSkill, removeSkill, listSkillSummaries } from "./skills.js";
import { searchFts, getSkill as getSkillById } from "./sqlite-store.js";

export const tools = [
  {
    type: "function",
    function: {
      name: "memory_write",
      description: "Save a fact, decision, or observation to persistent memory. Use this when you learn something important that should be remembered across sessions.",
      parameters: {
        type: "object",
        properties: {
          content: { type: "string", description: "The information to remember" },
          category: { type: "string", description: "Category: facts, decisions, preferences, bugs, patterns", default: "general" },
          importance: { type: "integer", description: "1-3, where 3 is critical", default: 1 },
        },
        required: ["content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "memory_search",
      description: "Search persistent memory for relevant information. Use this to recall previously saved knowledge.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
          limit: { type: "integer", description: "Max results", default: 10 },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "memory_get",
      description: "Get a specific memory by ID or list recent memories.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "integer", minimum: 1, description: "Positive memory ID to retrieve; omit when listing recent memories" },
          last: { type: "integer", minimum: 1, description: "Number of recent memories to list; takes precedence over id" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "memory_delete",
      description: "Delete a memory by ID.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "integer", description: "Memory ID to delete" },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "skill_add",
      description: "Create a reusable skill — a named procedure the agent remembers permanently. Use when you learn a multi-step workflow the user might need again (e.g. 'how we deploy', 'how to run tests for this project').",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Short name for the skill, e.g. 'Deploy to staging'" },
          content: { type: "string", description: "Full procedure in markdown. Include steps, commands, and caveats." },
          tags: { type: "string", description: "Comma-separated tags, e.g. 'deploy, aws, staging'" },
        },
        required: ["name", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "skill_update",
      description: "Update the content of an existing skill.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Skill ID (from skill_list)" },
          content: { type: "string", description: "New content replacing the old" },
        },
        required: ["id", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "skill_remove",
      description: "Delete a skill permanently.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Skill ID to delete" },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "memory_expand",
      description: "Retrieve full content of a skill or memory entry by ID. Use when the system prompt shows a skill index (§ heading) and you need the full procedure. Alias: load_skill.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Entry ID (skill-xxx or memory ID)" },
          layer: { type: "string", description: "Layer: skills, reflections, patterns, facts, user_model", default: "skills" },
        },
        required: ["id"],
      },
    },
  },
];

export const handlers = {
  memory_write(args) {
    const entry = insertMemory({
      content: args.content,
      category: args.category ?? "general",
      importance: args.importance ?? 1,
    });
    updateMemoryMd();
    return `Saved memory #${entry.id} [${entry.category}]: ${entry.content}`;
  },

  memory_search(args) {
    const results = searchMemories(args.query, args.limit ?? 10);
    if (!results.length) return "No memories found matching your query.";
    return results.map((m) => {
      const date = m.created_at?.slice(0, 10) || "";
      return `[#${m.id}] (${m.category}) ${date}: ${m.content} [score: ${m.score.toFixed(1)}]`;
    }).join("\n");
  },

  memory_get(args) {
    const recentCount = Number.isInteger(args.last) && args.last > 0 ? args.last : null;
    if (recentCount === null && Number.isInteger(args.id) && args.id > 0) {
      const m = getMemory(args.id);
      if (!m) return `Memory #${args.id} not found.`;
      return `[#${m.id}] (${m.category}) ${m.created_at}: ${m.content} [importance: ${m.importance}]`;
    }
    const recent = listRecentMemories(recentCount ?? 5);
    if (!recent.length) return "No memories stored yet.";
    return recent.map((m) => `[#${m.id}] (${m.category}) ${m.created_at?.slice(0, 10)}: ${m.content}`).join("\n");
  },

  memory_delete(args) {
    const ok = deleteMemory(args.id);
    if (ok) {
      updateMemoryMd();
      return `Deleted memory #${args.id}.`;
    }
    return `Memory #${args.id} not found.`;
  },

  skill_add(args) {
    const tags = args.tags ? args.tags.split(",").map(t => t.trim()).filter(Boolean) : [];
    const id = createSkill(args.name, args.content, tags);
    return `Created skill "${args.name}" (${id}). Stored as markdown in ~/.flint/memory/skills/ and indexed for search.`;
  },

  skill_update(args) {
    const ok = updateSkill(args.id, args.content);
    return ok ? `Updated skill ${args.id}.` : `Skill ${args.id} not found.`;
  },

  skill_remove(args) {
    const ok = removeSkill(args.id);
    return ok ? `Removed skill ${args.id} (file deleted).` : `Skill ${args.id} not found.`;
  },

  memory_expand(args) {
    const layer = args.layer || "skills";
    if (layer === "skills") {
      const skill = getSkillById(args.id);
      if (!skill) return `Skill ${args.id} not found.`;
      return `# ${skill.name}\n\n${skill.content}`;
    }
    // For other layers — FTS search by id
    const results = searchFts(args.id, { limit: 1 });
    if (results.length) return results[0].text;
    return `Entry ${args.id} not found in layer ${layer}.`;
  },
};
