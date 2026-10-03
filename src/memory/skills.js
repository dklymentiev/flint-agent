// Skills memory — Layer 3 of memory architecture.
//
// Reusable procedures stored as markdown files in ~/.flint/memory/skills/.
// Synced bidirectionally with SQLite skills table.
// Human-editable: user can write/edit .md files directly.
// Agent-editable: agent can create/update via tool actions.
//
// Internal task reference removed.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join, basename, resolve } from "node:path";
import { homedir } from "node:os";
import { insertSkill, getAllSkills, getSkill, deleteSkill, indexEntry } from "./sqlite-store.js";

const SKILLS_DIR = process.env.FLINT_DATA_DIR
  ? join(resolve(process.env.FLINT_DATA_DIR), "memory", "skills")
  : join(homedir(), ".flint", "memory", "skills");
const MAX_SKILLS = 50;

function ensureDir() {
  if (!existsSync(SKILLS_DIR)) mkdirSync(SKILLS_DIR, { recursive: true });
}

/**
 * Parse a markdown skill file. Optional YAML-like frontmatter:
 *   ---
 *   tags: deploy, aws
 *   ---
 *   # Skill title
 *   Content...
 */
function parseSkillFile(filePath) {
  const raw = readFileSync(filePath, "utf-8");
  const fileName = basename(filePath, ".md");
  let tags = [];
  let content = raw;
  let name = fileName;

  // Extract frontmatter
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (fmMatch) {
    const fm = fmMatch[1];
    content = fmMatch[2].trim();
    const tagsMatch = fm.match(/tags:\s*(.+)/);
    if (tagsMatch) tags = tagsMatch[1].split(",").map(t => t.trim()).filter(Boolean);
  }

  // Extract title from first # heading
  const titleMatch = content.match(/^#\s+(.+)/m);
  if (titleMatch) name = titleMatch[1].trim();

  return { id: `skill-${fileName}`, name, content, tags, source_file: filePath };
}

/**
 * Sync markdown files → SQLite table.
 * Called at startup. Adds new files, updates changed, removes deleted.
 */
export function syncFromDisk() {
  ensureDir();
  const files = readdirSync(SKILLS_DIR).filter(f => f.endsWith(".md"));
  const dbSkills = getAllSkills();
  const dbMap = new Map(dbSkills.map(s => [s.id, s]));
  const fileIds = new Set();

  for (const f of files) {
    const filePath = join(SKILLS_DIR, f);
    try {
      const parsed = parseSkillFile(filePath);
      fileIds.add(parsed.id);
      const existing = dbMap.get(parsed.id);
      // Insert or update if content changed
      if (!existing || existing.content !== parsed.content) {
        insertSkill(parsed);
        indexEntry("skills", parsed.id, [parsed.name, parsed.content].join(" "));
      }
    } catch {}
  }

  // Remove skills from DB that no longer have files
  for (const s of dbSkills) {
    if (s.source_file && !fileIds.has(s.id)) {
      deleteSkill(s.id);
    }
  }

  return { synced: fileIds.size, total: files.length };
}

/**
 * Create a new skill from agent (writes both DB + file).
 * @param {string} name — human-readable name
 * @param {string} content — markdown content
 * @param {string[]} tags — optional tags
 * @returns {string} skill id
 */
export function createSkill(name, content, tags = []) {
  ensureDir();
  // Enforce cap
  const existing = getAllSkills();
  if (existing.length >= MAX_SKILLS) {
    // Evict oldest
    const oldest = existing[existing.length - 1];
    if (oldest) {
      deleteSkill(oldest.id);
      if (oldest.source_file && existsSync(oldest.source_file)) {
        try { unlinkSync(oldest.source_file); } catch {}
      }
    }
  }

  const slug = name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").slice(0, 60);
  const id = `skill-${slug}`;
  const filePath = join(SKILLS_DIR, `${slug}.md`);

  // Build markdown with frontmatter
  let md = "";
  if (tags.length) {
    md += `---\ntags: ${tags.join(", ")}\n---\n`;
  }
  md += `# ${name}\n\n${content}\n`;

  writeFileSync(filePath, md, "utf-8");
  insertSkill({ id, name, content, source_file: filePath, tags });
  indexEntry("skills", id, [name, content].join(" "));
  return id;
}

/**
 * Update an existing skill content.
 */
export function updateSkill(id, content) {
  const skill = getSkill(id);
  if (!skill) return false;
  skill.content = content;
  insertSkill(skill);
  indexEntry("skills", id, [skill.name, content].join(" "));
  // Update file
  if (skill.source_file && existsSync(skill.source_file)) {
    let md = "";
    if (skill.tags?.length) {
      md += `---\ntags: ${skill.tags.join(", ")}\n---\n`;
    }
    md += `# ${skill.name}\n\n${content}\n`;
    writeFileSync(skill.source_file, md, "utf-8");
  }
  return true;
}

/**
 * Remove a skill (DB + file).
 */
export function removeSkill(id) {
  const skill = getSkill(id);
  if (!skill) return false;
  deleteSkill(id);
  if (skill.source_file && existsSync(skill.source_file)) {
    try { unlinkSync(skill.source_file); } catch {}
  }
  return true;
}

/**
 * List all skills as summaries (for prompt injection).
 * @returns {Array<{id, name, tags}>}
 */
export function listSkillSummaries() {
  return getAllSkills().map(s => ({ id: s.id, name: s.name, tags: s.tags }));
}

/**
 * Format skills as a system-prompt-ready block.
 * Progressive disclosure: only names + tags, agent uses memory_expand to get full content.
 * @returns {string}
 */
export function formatForPrompt() {
  const skills = getAllSkills();
  if (!skills.length) return "";
  const lines = ["Available skills (use load_skill or memory_expand to see full content):"];
  for (const s of skills) {
    const tagStr = s.tags?.length ? ` [${s.tags.join(", ")}]` : "";
    // First non-empty line of content as description (~60 chars)
    const desc = s.content
      ? s.content.split("\n").find(l => l.trim() && !l.startsWith("#"))?.trim().slice(0, 60) || ""
      : "";
    lines.push(`  § ${s.name}${tagStr}${desc ? " — " + desc : ""}`);
  }
  return lines.join("\n");
}

export const __internal = { SKILLS_DIR, MAX_SKILLS };
