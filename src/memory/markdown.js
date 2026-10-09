import { writeFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { loadAll, getMemoryStats } from "./store.js";

const memoryRoot = process.env.FLINT_DATA_DIR
  ? path.resolve(process.env.FLINT_DATA_DIR)
  : config.projectRoot;
const MEMORY_MD = path.join(memoryRoot, "MEMORY.md");

export function updateMemoryMd() {
  const memories = loadAll();
  const stats = getMemoryStats();
  const grouped = {};
  for (const m of memories) {
    if (!grouped[m.category]) grouped[m.category] = [];
    grouped[m.category].push(m);
  }

  let md = `# Agent Memory (${stats.total} entries)\n\n`;

  for (const [cat, items] of Object.entries(grouped)) {
    md += `## ${cat} (${items.length})\n`;
    for (const m of items) {
      const date = m.created_at?.slice(0, 10) || "unknown";
      const stars = "*".repeat(Math.min(m.importance, 3));
      md += `- [#${m.id}] ${date}: ${m.content} ${stars}\n`;
    }
    md += "\n";
  }

  md += `Last updated: ${new Date().toISOString()}\n`;
  writeFileSync(MEMORY_MD, md, "utf-8");
  return md;
}

export function readMemoryMdHead(lines = 50) {
  if (!existsSync(MEMORY_MD)) return "";
  const content = readFileSync(MEMORY_MD, "utf-8");
  return content.split("\n").slice(0, lines).join("\n");
}
