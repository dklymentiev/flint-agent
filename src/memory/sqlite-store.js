// Unified SQLite memory store — all memory layers in one file.
//
// Layers: reflections (L1), patterns (L2), skills (L3), facts (L4), user_model (L5).
// Migration: reads existing JSONL on first run, inserts into tables, renames JSONL to .migrated.
//

import os from "node:os";
import Database from "better-sqlite3";
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import path from "node:path";
import { join } from "node:path";
import { createRequire } from "node:module";
import { homeStateDir } from "../data-dir.js";
const require = createRequire(import.meta.url);

// FLINT_DATA_DIR moves the memory database off the shared default, so a bench
// subject does not read and write the operator's own memory. On 2026-09-21 the
// readiness subject and the live agent shared this file, and so did the unit
// test that clears the facts table in beforeEach.
//
// Re-resolved on every call: a stale cache would freeze the first value of
// FLINT_DATA_DIR (or the first mocked homedir()) for the lifetime of the
// process, defeating test isolation that changes env vars or mocks os.homedir()
// after import.
function getDir() {
  return join(homeStateDir(), "memory");
}

function getDbPath() {
  return join(getDir(), "index.sqlite");
}

let _db = null;
let _vecEnabled = false;
const EMBEDDING_PROVIDER = process.env.AGENT_MEMORY_EMBEDDING || "none";
const EMBEDDING_DIM = 384; // nomic-embed default; OpenAI ada = 1536

function ensureDir(dir = getDir()) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/** Where this instance keeps its memory. Answers "which database am I on?". */
export function memoryDbPath() {
  return getDbPath();
}

/** True when child is dir itself or lies inside it (a path boundary, not a string prefix). */
function isInside(child, dir) {
  const rel = path.relative(dir, child);
  if (rel === "") return true;
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Under a test runner the memory directory (the one getDir() resolved from
 * FLINT_DATA_DIR, else from os.homedir(), which follows USERPROFILE on
 * Windows and HOME elsewhere) must lie inside the temp directory. v1.14.5
 * threw without FLINT_DATA_DIR; 1.14.6 looked only at HOME, so FLINT_DATA_DIR
 * pointing at the real ~/.flint passed. Checking the resolved directory covers
 * both ways of redirecting, with a path boundary rather than a string prefix.
 */
export function assertTestSandbox(dir, env = process.env) {
  if (env.VITEST !== "true") return;
  const norm = (p) => (process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p));
  const target = norm(dir);
  const tmp = norm(os.tmpdir());
  const bad = (why) => {
    throw new Error(
      "Refusing to open real ~/.flint database under test runner: " + why +
      ' ("' + dir + '"). Point FLINT_DATA_DIR, or HOME and USERPROFILE, at a temp directory in the vitest config.'
    );
  };
  if (!isInside(target, tmp) || target === tmp) bad("not inside the temp directory " + tmp);
}

export function getDb() {
  if (_db) return _db;
  assertTestSandbox(getDir());
  ensureDir();
  _db = new Database(getDbPath());
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");

  // Try loading sqlite-vec extension for vector search
  if (EMBEDDING_PROVIDER !== "none") {
    try {
      const { load } = require("sqlite-vec");
      load(_db);
      _vecEnabled = true;
    } catch {
      // sqlite-vec not available — fall back to FTS5 only
    }
  }

  initSchema(_db);
  return _db;
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS reflections (
      id TEXT PRIMARY KEY,
      ts TEXT NOT NULL,
      session_id TEXT DEFAULT '',
      did TEXT DEFAULT '',
      wrong TEXT DEFAULT '[]',
      better TEXT DEFAULT '[]',
      tags TEXT DEFAULT '[]',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS patterns (
      id TEXT PRIMARY KEY,
      ts TEXT NOT NULL,
      session_id TEXT DEFAULT '',
      request TEXT DEFAULT '',
      tokens TEXT DEFAULT '[]',
      first_tool TEXT DEFAULT '',
      all_tools TEXT DEFAULT '[]',
      ok INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS skills (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      content TEXT DEFAULT '',
      source_file TEXT DEFAULT '',
      tags TEXT DEFAULT '[]',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS facts (
      id TEXT PRIMARY KEY,
      category TEXT DEFAULT 'general',
      content TEXT NOT NULL,
      source TEXT DEFAULT 'agent',
      confidence REAL DEFAULT 1.0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS user_model (
      id TEXT PRIMARY KEY,
      trait TEXT NOT NULL,
      value TEXT DEFAULT '',
      evidence TEXT DEFAULT '',
      confidence REAL DEFAULT 0.5,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- Migration: add success tracking columns to patterns (Phase 2)
    -- ALTER TABLE is idempotent via pragma check below.

    -- FTS5 full-text search across all text-heavy layers.
    -- Stores own copy of text for direct retrieval without JOINs.
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
      layer,
      entry_id,
      text,
      tokenize='unicode61 remove_diacritics 2'
    );
  `);

  // Migration: add success tracking to patterns
  const cols = db.pragma("table_info(patterns)").map(c => c.name);
  if (!cols.includes("success_count")) {
    db.exec(`
      ALTER TABLE patterns ADD COLUMN success_count INTEGER DEFAULT 1;
      ALTER TABLE patterns ADD COLUMN fail_count INTEGER DEFAULT 0;
      ALTER TABLE patterns ADD COLUMN version INTEGER DEFAULT 1;
    `);
  }

  // Migration: add project scope to facts
  // NULL project = global (about the user). Set project = "flint" etc for scoped.
  const factCols = db.pragma("table_info(facts)").map(c => c.name);
  if (!factCols.includes("project")) {
    db.exec(`ALTER TABLE facts ADD COLUMN project TEXT`);
  }

  // Migration: add pinned flag to facts (2026-04-20).
  // pinned=1 means the fact is never LRU-evicted. Defends curated knowledge
  // (user preferences, project metadata) from being pushed out by transient
  // session artifacts during heavy benchmark/workflow runs.
  if (!factCols.includes("pinned")) {
    db.exec(`ALTER TABLE facts ADD COLUMN pinned INTEGER DEFAULT 0`);
  }
}

// -- Reflections (L1) --

export function insertReflection(r) {
  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO reflections (id, ts, session_id, did, wrong, better, tags)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    r.id, r.ts, r.session_id || "",
    r.did || "",
    JSON.stringify(r.wrong || []),
    JSON.stringify(r.better || []),
    JSON.stringify(r.tags || [])
  );
  // Auto-index for FTS5 search
  const ftsText = [r.did, ...(r.wrong || []), ...(r.better || [])].filter(Boolean).join(" ");
  indexEntry("reflections", r.id, ftsText);
  return r.id;
}

export function getRecentReflections(n = 5) {
  const db = getDb();
  return db.prepare("SELECT * FROM reflections ORDER BY ts DESC, rowid DESC LIMIT ?").all(n).map(deserializeReflection);
}

export function getAllReflections() {
  return getDb().prepare("SELECT * FROM reflections ORDER BY ts ASC").all().map(deserializeReflection);
}

export function countReflections() {
  return getDb().prepare("SELECT COUNT(*) as c FROM reflections").get().c;
}

function deserializeReflection(row) {
  return {
    id: row.id, ts: row.ts, session_id: row.session_id,
    did: row.did,
    wrong: safeParse(row.wrong, []),
    better: safeParse(row.better, []),
    tags: safeParse(row.tags, []),
  };
}

// -- Patterns (L2) --

export function insertPattern(p) {
  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO patterns (id, ts, session_id, request, tokens, first_tool, all_tools, ok, success_count, fail_count, version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    p.id, p.ts, p.session_id || "",
    p.request || "",
    JSON.stringify(p.tokens || []),
    p.first_tool || "",
    JSON.stringify(p.all_tools || []),
    p.ok !== false ? 1 : 0,
    p.success_count ?? 1,
    p.fail_count ?? 0,
    p.version ?? 1
  );
  indexEntry("patterns", p.id, [p.request || "", p.first_tool || ""].join(" "));
}

/**
 * Increment success_count for an existing pattern.
 */
export function incrementPatternSuccess(id) {
  getDb().prepare("UPDATE patterns SET success_count = success_count + 1, ts = datetime('now') WHERE id = ?").run(id);
}

/**
 * Increment fail_count for an existing pattern.
 */
export function incrementPatternFail(id) {
  getDb().prepare("UPDATE patterns SET fail_count = fail_count + 1 WHERE id = ?").run(id);
}

/**
 * Find a pattern with overlapping tokens and same first_tool (for dedup/versioning).
 * Returns the most recent match or null.
 */
export function findSimilarPattern(tokens, firstTool) {
  if (!tokens?.length) return null;
  const db = getDb();
  const all = db.prepare("SELECT * FROM patterns ORDER BY ts DESC").all();
  for (const row of all) {
    const rowTokens = safeParse(row.tokens, []);
    if (row.first_tool !== firstTool) continue;
    // Jaccard similarity >= 0.5
    const intersection = tokens.filter(t => rowTokens.includes(t)).length;
    const union = new Set([...tokens, ...rowTokens]).size;
    if (union > 0 && intersection / union >= 0.5) {
      return deserializePattern(row);
    }
  }
  return null;
}

/**
 * Replace a pattern's tool choice (versioning on correction).
 */
export function replacePatternTool(id, newTool, newAllTools) {
  getDb().prepare(`
    UPDATE patterns SET first_tool = ?, all_tools = ?, version = version + 1, fail_count = fail_count + 1, ts = datetime('now')
    WHERE id = ?
  `).run(newTool, JSON.stringify(newAllTools || [newTool]), id);
}

export function getAllPatterns() {
  return getDb().prepare("SELECT * FROM patterns ORDER BY ts ASC").all().map(deserializePattern);
}

/**
 * Get top patterns by success rate, for session-stable prompt injection.
 */
export function getTopPatterns(limit = 20) {
  return getDb().prepare(`
    SELECT *, CAST(success_count AS REAL) / MAX(success_count + fail_count, 1) AS success_rate
    FROM patterns
    WHERE success_count > 0
    ORDER BY success_rate DESC, success_count DESC
    LIMIT ?
  `).all(limit).map(deserializePattern);
}

export function countPatterns() {
  return getDb().prepare("SELECT COUNT(*) as c FROM patterns").get().c;
}

function deserializePattern(row) {
  return {
    id: row.id, ts: row.ts, session_id: row.session_id,
    request: row.request,
    tokens: safeParse(row.tokens, []),
    first_tool: row.first_tool,
    all_tools: safeParse(row.all_tools, []),
    ok: row.ok !== 0,
    success_count: row.success_count ?? 1,
    fail_count: row.fail_count ?? 0,
    version: row.version ?? 1,
  };
}

// -- Skills (L3) --

export function insertSkill(s) {
  getDb().prepare(`
    INSERT OR REPLACE INTO skills (id, name, content, source_file, tags, updated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
  `).run(s.id, s.name, s.content || "", s.source_file || "", JSON.stringify(s.tags || []));
}

export function getAllSkills() {
  return getDb().prepare("SELECT * FROM skills ORDER BY name").all().map(r => ({
    ...r, tags: safeParse(r.tags, [])
  }));
}

export function getSkill(id) {
  const row = getDb().prepare("SELECT * FROM skills WHERE id = ?").get(id);
  return row ? { ...row, tags: safeParse(row.tags, []) } : null;
}

export function deleteSkill(id) {
  getDb().prepare("DELETE FROM skills WHERE id = ?").run(id);
}

// -- Facts (L4) --

export function insertFact(f) {
  getDb().prepare(`
    INSERT OR REPLACE INTO facts (id, category, content, source, confidence, project, pinned)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(f.id, f.category || "general", f.content, f.source || "agent", f.confidence ?? 1.0, f.project || null, f.pinned ? 1 : 0);
}

/**
 * Mark fact as pinned (never LRU-evicted). Used for curated knowledge.
 */
export function setFactPinned(id, pinned) {
  getDb().prepare("UPDATE facts SET pinned = ? WHERE id = ?").run(pinned ? 1 : 0, id);
}

/**
 * Get all facts, optionally filtered by project.
 *
 * @param {object} [opts]
 * @param {string|null} [opts.project] — project name; NULL or undefined = all scopes;
 *   empty string "" = global only; "flint" = flint + global (implicit union).
 */
export function getAllFacts(opts = {}) {
  const db = getDb();
  const p = opts.project;
  if (p === undefined || p === null) {
    // All facts (no scope filter)
    return db.prepare("SELECT * FROM facts ORDER BY created_at DESC").all();
  }
  if (p === "") {
    // Global only — project IS NULL
    return db.prepare("SELECT * FROM facts WHERE project IS NULL ORDER BY created_at DESC").all();
  }
  // Named project — include scoped + global (two-bucket union)
  return db.prepare("SELECT * FROM facts WHERE project = ? OR project IS NULL ORDER BY created_at DESC").all(p);
}

export function deleteFact(id) {
  getDb().prepare("DELETE FROM facts WHERE id = ?").run(id);
}

// -- User Model (L5) --

export function upsertTrait(trait, value, evidence, confidence) {
  const id = "trait-" + trait.toLowerCase().replace(/\s+/g, "-").slice(0, 50);
  getDb().prepare(`
    INSERT INTO user_model (id, trait, value, evidence, confidence, updated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET value=?, evidence=?, confidence=?, updated_at=datetime('now')
  `).run(id, trait, value, evidence, confidence, value, evidence, confidence);
}

export function getAllTraits() {
  return getDb().prepare("SELECT * FROM user_model ORDER BY confidence DESC").all();
}

// -- Migration from JSONL --

export function migrateFromJsonl() {
  const db = getDb();
  let migrated = { reflections: 0, patterns: 0 };

  const reflFile = join(getDir(), "reflections.jsonl");
  if (existsSync(reflFile) && countReflections() === 0) {
    const lines = readFileSync(reflFile, "utf-8").split("\n").filter(l => l.trim());
    const insert = db.prepare(`
      INSERT OR IGNORE INTO reflections (id, ts, session_id, did, wrong, better, tags)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    db.transaction(() => {
      for (const line of lines) {
        try {
          const r = JSON.parse(line);
          insert.run(r.id, r.ts, r.session_id || "", r.did || "",
            JSON.stringify(r.wrong || []), JSON.stringify(r.better || []), JSON.stringify(r.tags || []));
          migrated.reflections++;
        } catch {}
      }
    })();
    renameSync(reflFile, reflFile + ".migrated");
  }

  const patFile = join(getDir(), "patterns.jsonl");
  if (existsSync(patFile) && countPatterns() === 0) {
    const lines = readFileSync(patFile, "utf-8").split("\n").filter(l => l.trim());
    const insert = db.prepare(`
      INSERT OR IGNORE INTO patterns (id, ts, session_id, request, tokens, first_tool, all_tools, ok)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    db.transaction(() => {
      for (const line of lines) {
        try {
          const p = JSON.parse(line);
          insert.run(p.id, p.ts, p.session_id || "", p.request || "",
            JSON.stringify(p.tokens || []), p.first_tool || "", JSON.stringify(p.all_tools || []),
            p.ok !== false ? 1 : 0);
          migrated.patterns++;
        } catch {}
      }
    })();
    renameSync(patFile, patFile + ".migrated");
  }

  return migrated;
}

// -- FTS5 Full-Text Search --

/**
 * Index a memory entry into FTS5 for keyword search.
 * Call after every insert/update to keep index fresh.
 * @param {string} layer — "reflections"|"patterns"|"skills"|"facts"|"user_model"
 * @param {string} entryId — row id in the source table
 * @param {string} text — searchable text content
 */
export function indexEntry(layer, entryId, text) {
  const db = getDb();
  // Remove old entry first (external-content FTS needs manual sync)
  db.prepare("DELETE FROM memory_fts WHERE entry_id = ? AND layer = ?").run(entryId, layer);
  if (text && text.trim()) {
    db.prepare("INSERT INTO memory_fts (layer, entry_id, text) VALUES (?, ?, ?)").run(layer, entryId, text);
  }
}

/**
 * Search across all memory layers via FTS5.
 * Returns matching entries ranked by BM25 relevance.
 * @param {string} query — user search terms
 * @param {object} opts
 * @param {number} opts.limit — max results (default 10)
 * @param {string} opts.layer — filter to specific layer (optional)
 * @returns {Array<{layer, entry_id, text, rank}>}
 */
export function searchFts(query, opts = {}) {
  const db = getDb();
  const limit = opts.limit || 10;
  if (!query || !query.trim()) return [];

  // Escape FTS5 special chars and build query
  const cleaned = query.replace(/['"(){}[\]*:^~!@#$%&]/g, " ").trim();
  if (!cleaned) return [];

  try {
    if (opts.layer) {
      return db.prepare(`
        SELECT layer, entry_id, text, rank
        FROM memory_fts
        WHERE memory_fts MATCH ? AND layer = ?
        ORDER BY rank
        LIMIT ?
      `).all(cleaned, opts.layer, limit);
    }
    return db.prepare(`
      SELECT layer, entry_id, text, rank
      FROM memory_fts
      WHERE memory_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(cleaned, limit);
  } catch {
    return [];
  }
}

/**
 * Rebuild the FTS5 index from all source tables.
 * Call after migration or if index seems corrupt.
 */
export function rebuildFtsIndex() {
  const db = getDb();
  // Clear existing index
  db.prepare("DELETE FROM memory_fts").run();

  // Index reflections: combine did + wrong + better
  const reflections = db.prepare("SELECT id, did, wrong, better FROM reflections").all();
  const insertFts = db.prepare("INSERT INTO memory_fts (layer, entry_id, text) VALUES (?, ?, ?)");
  db.transaction(() => {
    for (const r of reflections) {
      const parts = [r.did, ...safeParse(r.wrong, []), ...safeParse(r.better, [])].filter(Boolean);
      if (parts.length) insertFts.run("reflections", r.id, parts.join(" "));
    }
    // Index patterns: request text
    const patterns = db.prepare("SELECT id, request FROM patterns").all();
    for (const p of patterns) {
      if (p.request) insertFts.run("patterns", p.id, p.request);
    }
    // Index skills: name + content
    const skills = db.prepare("SELECT id, name, content FROM skills").all();
    for (const s of skills) {
      insertFts.run("skills", s.id, [s.name, s.content].filter(Boolean).join(" "));
    }
    // Index facts: content
    const facts = db.prepare("SELECT id, content FROM facts").all();
    for (const f of facts) {
      if (f.content) insertFts.run("facts", f.id, f.content);
    }
    // Index user_model: trait + value
    const traits = db.prepare("SELECT id, trait, value FROM user_model").all();
    for (const t of traits) {
      insertFts.run("user_model", t.id, [t.trait, t.value].filter(Boolean).join(" "));
    }
  })();
  return { indexed: reflections.length + db.prepare("SELECT COUNT(*) as c FROM patterns").get().c };
}

// -- Helpers --

function safeParse(str, fallback) {
  try { return JSON.parse(str); } catch { return fallback; }
}

// -- Vector Search (sqlite-vec) --

/**
 * Check if vector search is available.
 */
export function isVecEnabled() {
  return _vecEnabled;
}

/**
 * Store a vector embedding for a memory entry.
 * @param {string} layer
 * @param {string} entryId
 * @param {Float32Array|number[]} embedding
 */
export function storeEmbedding(layer, entryId, embedding) {
  if (!_vecEnabled) return;
  const db = getDb();
  try {
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS memory_vec USING vec0(
      layer TEXT,
      entry_id TEXT,
      embedding float[${EMBEDDING_DIM}]
    )`);
  } catch {} // table may already exist
  // Remove old embedding
  try { db.prepare("DELETE FROM memory_vec WHERE entry_id = ? AND layer = ?").run(entryId, layer); } catch {}
  try {
    const buf = Buffer.from(new Float32Array(embedding).buffer);
    db.prepare("INSERT INTO memory_vec (layer, entry_id, embedding) VALUES (?, ?, ?)").run(layer, entryId, buf);
  } catch {}
}

/**
 * Semantic vector search across memory.
 * @param {Float32Array|number[]} queryEmbedding
 * @param {object} opts — { limit, layer }
 * @returns {Array<{layer, entry_id, distance}>}
 */
export function searchVec(queryEmbedding, opts = {}) {
  if (!_vecEnabled) return [];
  const db = getDb();
  const limit = opts.limit || 10;
  const buf = Buffer.from(new Float32Array(queryEmbedding).buffer);
  try {
    if (opts.layer) {
      return db.prepare(`
        SELECT layer, entry_id, distance
        FROM memory_vec
        WHERE embedding MATCH ? AND layer = ?
        ORDER BY distance
        LIMIT ?
      `).all(buf, opts.layer, limit);
    }
    return db.prepare(`
      SELECT layer, entry_id, distance
      FROM memory_vec
      WHERE embedding MATCH ?
      ORDER BY distance
      LIMIT ?
    `).all(buf, limit);
  } catch {
    return [];
  }
}

/**
 * Hybrid search: combine FTS5 (BM25) + vector scores.
 * Returns unified results ranked by combined score.
 * @param {string} query — text query for FTS
 * @param {Float32Array|number[]} queryEmbedding — vector for semantic search
 * @param {object} opts
 * @returns {Array<{layer, entry_id, text, score}>}
 */
export function searchHybrid(query, queryEmbedding, opts = {}) {
  const limit = opts.limit || 10;
  const ftsResults = searchFts(query, { limit: limit * 2, layer: opts.layer });
  const vecResults = _vecEnabled && queryEmbedding
    ? searchVec(queryEmbedding, { limit: limit * 2, layer: opts.layer })
    : [];

  // Merge by entry_id, combine scores
  const scores = new Map();
  for (const r of ftsResults) {
    const key = `${r.layer}:${r.entry_id}`;
    scores.set(key, { ...r, ftsRank: Math.abs(r.rank || 0), vecDist: Infinity, score: 0 });
  }
  for (const r of vecResults) {
    const key = `${r.layer}:${r.entry_id}`;
    if (scores.has(key)) {
      scores.get(key).vecDist = r.distance;
    } else {
      scores.set(key, { layer: r.layer, entry_id: r.entry_id, text: "", ftsRank: 0, vecDist: r.distance, score: 0 });
    }
  }

  // Score: normalize and combine (0.6 FTS + 0.4 vector)
  const maxFts = Math.max(...[...scores.values()].map(s => s.ftsRank), 1);
  const maxVec = Math.max(...[...scores.values()].filter(s => s.vecDist < Infinity).map(s => s.vecDist), 1);
  for (const s of scores.values()) {
    const ftsScore = s.ftsRank / maxFts;
    const vecScore = s.vecDist < Infinity ? (1 - s.vecDist / maxVec) : 0;
    s.score = 0.6 * ftsScore + 0.4 * vecScore;
  }

  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export function closeDb() {
  if (_db) { _db.close(); _db = null; _vecEnabled = false; }
}

export const __internal = { getDir, getDbPath, EMBEDDING_DIM, isVecEnabled: () => _vecEnabled };
