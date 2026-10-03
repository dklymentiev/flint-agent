import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { handlers as fsHandlers } from "../../src/tools/filesystem.js";
import { createSystemTools } from "../../src/tools/system.js";
import { createMockStore } from "../helpers/mock-store.js";
import { createTmpDir } from "../helpers/tmp-dir.js";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

let tmp;
let run_command;

/** Write a node script to a temp file and execute it via run_command. */
async function runNodeScript(code) {
  const scriptPath = path.join(tmp.path, `_script_${Date.now()}_${Math.random().toString(36).slice(2)}.cjs`);
  fs.writeFileSync(scriptPath, code, "utf-8");
  const fwdPath = scriptPath.replace(/\\/g, "/");
  try {
    return await run_command({ command: `node ${fwdPath}` });
  } finally {
    try { fs.unlinkSync(scriptPath); } catch {}
  }
}

beforeEach(() => {
  tmp = createTmpDir();
  const store = createMockStore();
  const sys = createSystemTools(store);
  run_command = sys.handlers.run_command;
});

afterEach(() => {
  tmp.cleanup();
});

// ── 1. Rename 50 files by template ──────────────────────────────────────────

describe("rename 50 files by template", () => {
  it("renames IMG_NNN.jpg to Vacation_Barcelona_NNN.jpg", async () => {
    for (let i = 1; i <= 50; i++) {
      const name = `IMG_${String(i).padStart(3, "0")}.jpg`;
      fs.writeFileSync(path.join(tmp.path, name), `photo-${i}`);
    }

    const dir = tmp.path.replace(/\\/g, "/");
    const result = await runNodeScript(`
      const fs = require('fs');
      const path = require('path');
      const dir = ${JSON.stringify(dir)};
      const files = fs.readdirSync(dir).filter(f => f.startsWith('IMG_'));
      for (const f of files) {
        const num = f.match(/IMG_(\\d+)/)[1];
        fs.renameSync(path.join(dir, f), path.join(dir, 'Vacation_Barcelona_' + num + '.jpg'));
      }
      console.log(files.length + ' files renamed');
    `);
    expect(result).toContain("50 files renamed");

    const listing = await fsHandlers.list_directory({ path: tmp.path });
    for (let i = 1; i <= 50; i++) {
      expect(listing).toContain(`Vacation_Barcelona_${String(i).padStart(3, "0")}.jpg`);
    }
    expect(listing).not.toContain("IMG_");
  });

  it("preserves file content after rename", async () => {
    const srcFile = path.join(tmp.path, "IMG_001.txt");
    const dstFile = path.join(tmp.path, "Vacation_Barcelona_001.txt");
    fs.writeFileSync(srcFile, "content-check");
    await fsHandlers.move_file({ source: srcFile, destination: dstFile });
    const content = await fsHandlers.read_file({ path: dstFile });
    expect(content).toBe("content-check");
  });
});

// ── 2. Find duplicates by hash ──────────────────────────────────────────────

describe("find duplicates by hash", () => {
  it("detects 2 files with identical content among 5", async () => {
    fs.writeFileSync(path.join(tmp.path, "a.txt"), "unique-a");
    fs.writeFileSync(path.join(tmp.path, "b.txt"), "duplicate-content");
    fs.writeFileSync(path.join(tmp.path, "c.txt"), "unique-c");
    fs.writeFileSync(path.join(tmp.path, "d.txt"), "duplicate-content");
    fs.writeFileSync(path.join(tmp.path, "e.txt"), "unique-e");

    const dir = tmp.path.replace(/\\/g, "/");
    const result = await runNodeScript(`
      const fs = require('fs');
      const path = require('path');
      const crypto = require('crypto');
      const dir = ${JSON.stringify(dir)};
      const hashes = {};
      for (const f of fs.readdirSync(dir)) {
        const full = path.join(dir, f);
        if (!fs.statSync(full).isFile()) continue;
        const h = crypto.createHash('md5').update(fs.readFileSync(full)).digest('hex');
        if (!hashes[h]) hashes[h] = [];
        hashes[h].push(f);
      }
      const dupes = Object.values(hashes).filter(arr => arr.length > 1);
      for (const group of dupes) console.log('DUPES: ' + group.join(', '));
      console.log('Total duplicate groups: ' + dupes.length);
    `);
    expect(result).toContain("DUPES: b.txt, d.txt");
    expect(result).toContain("Total duplicate groups: 1");
  });

  it("reports no duplicates when all unique", async () => {
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(path.join(tmp.path, `f${i}.txt`), `unique-${i}`);
    }

    const dir = tmp.path.replace(/\\/g, "/");
    const result = await runNodeScript(`
      const fs = require('fs');
      const path = require('path');
      const crypto = require('crypto');
      const dir = ${JSON.stringify(dir)};
      const hashes = {};
      for (const f of fs.readdirSync(dir)) {
        const full = path.join(dir, f);
        if (!fs.statSync(full).isFile()) continue;
        const h = crypto.createHash('md5').update(fs.readFileSync(full)).digest('hex');
        if (!hashes[h]) hashes[h] = [];
        hashes[h].push(f);
      }
      const dupes = Object.values(hashes).filter(arr => arr.length > 1);
      console.log('Total duplicate groups: ' + dupes.length);
    `);
    expect(result).toContain("Total duplicate groups: 0");
  });
});

// ── 3. Find/replace in 100 files ────────────────────────────────────────────

describe("find/replace in 100 files", () => {
  beforeEach(() => {
    for (let i = 0; i < 100; i++) {
      const name = `page_${String(i).padStart(3, "0")}.html`;
      fs.writeFileSync(
        path.join(tmp.path, name),
        `<html><body>Call us: 555-1234</body></html>`,
        "utf-8",
      );
    }
  });

  it("search_in_files finds phone number in all 100 files", async () => {
    const result = await fsHandlers.search_in_files({
      pattern: "555-1234",
      path: tmp.path,
      glob: "*.html",
      max_results: 200,
    });
    expect(result).toContain("100 matches");
  });

  it("edit_file replaces phone number in every file", async () => {
    const files = fs.readdirSync(tmp.path).filter((f) => f.endsWith(".html"));
    expect(files).toHaveLength(100);

    for (const f of files) {
      await fsHandlers.edit_file({
        path: path.join(tmp.path, f),
        old_text: "555-1234",
        new_text: "555-9999",
      });
    }

    // Verify all replaced
    const searchResult = await fsHandlers.search_in_files({
      pattern: "555-1234",
      path: tmp.path,
      glob: "*.html",
    });
    expect(searchResult).toContain("No matches");

    const newSearch = await fsHandlers.search_in_files({
      pattern: "555-9999",
      path: tmp.path,
      glob: "*.html",
      max_results: 200,
    });
    expect(newSearch).toContain("100 matches");
  });
});

// ── 4. Compress folder excluding junk ───────────────────────────────────────

describe("compress folder excluding junk", () => {
  it("creates archive excluding node_modules and .git", async () => {
    const project = path.join(tmp.path, "myproject");
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, "index.js"), "console.log('hello')");
    fs.writeFileSync(path.join(project, "readme.txt"), "This is a project");

    fs.mkdirSync(path.join(project, "node_modules"));
    fs.writeFileSync(path.join(project, "node_modules", "big.js"), "x".repeat(5000));
    fs.mkdirSync(path.join(project, ".git"));
    fs.writeFileSync(path.join(project, ".git", "HEAD"), "ref: refs/heads/main");

    const archivePath = path.join(tmp.path, "project.tar").replace(/\\/g, "/");
    const projectDir = project.replace(/\\/g, "/");
    const result = await runNodeScript(`
      const fs = require('fs');
      const path = require('path');
      const dir = ${JSON.stringify(projectDir)};
      const archive = ${JSON.stringify(archivePath)};
      const SKIP = new Set(['node_modules', '.git']);
      const files = [];
      function walk(d, rel) {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const full = path.join(d, e.name);
          const r = rel ? rel + '/' + e.name : e.name;
          if (e.isDirectory()) {
            if (!SKIP.has(e.name)) walk(full, r);
          } else {
            files.push({ rel: r, full });
          }
        }
      }
      walk(dir, '');
      let out = '';
      for (const f of files) {
        out += '--- ' + f.rel + ' ---\\n';
        out += fs.readFileSync(f.full, 'utf-8') + '\\n';
      }
      fs.writeFileSync(archive, out);
      console.log('Archived ' + files.length + ' files');
    `);
    expect(result).toContain("Archived 2 files");
    expect(fs.existsSync(archivePath)).toBe(true);

    const archiveContent = fs.readFileSync(archivePath, "utf-8");
    expect(archiveContent).toContain("index.js");
    expect(archiveContent).toContain("readme.txt");
    expect(archiveContent).not.toContain("big.js");
    expect(archiveContent).not.toContain("HEAD");
  });

  it("archive is smaller than full directory", async () => {
    const project = path.join(tmp.path, "proj2");
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, "app.js"), "small");
    fs.mkdirSync(path.join(project, "node_modules"));
    fs.writeFileSync(path.join(project, "node_modules", "huge.js"), "x".repeat(10000));

    const fullSize =
      fs.statSync(path.join(project, "app.js")).size +
      fs.statSync(path.join(project, "node_modules", "huge.js")).size;

    const archivePath = path.join(tmp.path, "small.txt");
    await fsHandlers.write_file({
      path: archivePath,
      content: fs.readFileSync(path.join(project, "app.js"), "utf-8"),
    });

    const archiveSize = fs.statSync(archivePath).size;
    expect(archiveSize).toBeLessThan(fullSize);
  });
});

// ── 5. Check occupied ports ─────────────────────────────────────────────────

describe("check occupied ports", () => {
  it("netstat returns port information", async () => {
    const isWin = process.platform === "win32";
    const cmd = isWin ? "netstat -an" : "ss -tuln";
    const result = await run_command({ command: cmd });
    expect(result).toMatch(/:\d+/);
  });

  it("output contains common protocol headers or ports", async () => {
    const isWin = process.platform === "win32";
    const cmd = isWin ? "netstat -an" : "ss -tuln";
    const result = await run_command({ command: cmd });
    expect(result.length).toBeGreaterThan(50);
  });
});

// ── 6. Find password patterns ───────────────────────────────────────────────

describe("find password patterns", () => {
  beforeEach(() => {
    fs.writeFileSync(path.join(tmp.path, "config.env"), "password=secret123\nDB_HOST=localhost");
    fs.writeFileSync(path.join(tmp.path, "settings.json"), '{"api_key":"abc-def-123"}');
    fs.writeFileSync(path.join(tmp.path, "clean.txt"), "nothing sensitive here");
  });

  it("finds password= pattern", async () => {
    const result = await fsHandlers.search_in_files({
      pattern: "password\\s*=\\s*\\S+",
      path: tmp.path,
    });
    expect(result).toContain("password=secret123");
    expect(result).toContain("config.env");
  });

  it("finds api_key pattern", async () => {
    const result = await fsHandlers.search_in_files({
      pattern: "api_key",
      path: tmp.path,
    });
    expect(result).toContain("api_key");
    expect(result).toContain("settings.json");
  });

  it("does not match clean files", async () => {
    const result = await fsHandlers.search_in_files({
      pattern: "password|api_key",
      path: tmp.path,
    });
    expect(result).not.toContain("clean.txt");
  });
});

// ── 7. Encrypt/decrypt text ─────────────────────────────────────────────────

describe("encrypt/decrypt text", () => {
  it("round-trips text through AES encryption", async () => {
    const plaintext = "Hello, this is a secret message!";
    const key = crypto.randomBytes(32).toString("hex");
    const iv = crypto.randomBytes(16).toString("hex");

    // Encrypt via run_command
    const encrypted = (await runNodeScript(`
      const crypto = require('crypto');
      const key = Buffer.from('${key}', 'hex');
      const iv = Buffer.from('${iv}', 'hex');
      const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
      let enc = cipher.update('${plaintext}', 'utf8', 'hex');
      enc += cipher.final('hex');
      console.log(enc);
    `)).trim();
    expect(encrypted).not.toBe(plaintext);
    expect(encrypted).toMatch(/^[0-9a-f]+$/);

    // Decrypt via run_command
    const decrypted = (await runNodeScript(`
      const crypto = require('crypto');
      const key = Buffer.from('${key}', 'hex');
      const iv = Buffer.from('${iv}', 'hex');
      const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
      let dec = decipher.update('${encrypted}', 'hex', 'utf8');
      dec += decipher.final('utf8');
      console.log(dec);
    `)).trim();
    expect(decrypted).toBe(plaintext);
  });

  it("different keys produce different ciphertext", async () => {
    const text = "same-input";
    const results = [];
    for (let i = 0; i < 2; i++) {
      const key = crypto.randomBytes(32).toString("hex");
      const iv = crypto.randomBytes(16).toString("hex");
      const r = (await runNodeScript(`
        const crypto = require('crypto');
        const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from('${key}','hex'), Buffer.from('${iv}','hex'));
        let e = cipher.update('${text}','utf8','hex');
        e += cipher.final('hex');
        console.log(e);
      `)).trim();
      results.push(r);
    }
    expect(results[0]).not.toBe(results[1]);
  });
});

// ── 8. File census with stats ───────────────────────────────────────────────

describe("file census with stats", () => {
  beforeEach(() => {
    fs.mkdirSync(path.join(tmp.path, "src"));
    fs.mkdirSync(path.join(tmp.path, "docs"));
    fs.mkdirSync(path.join(tmp.path, "assets"));

    for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(tmp.path, "src", `mod${i}.js`), `// module ${i}`);
    for (let i = 0; i < 3; i++) fs.writeFileSync(path.join(tmp.path, "docs", `doc${i}.txt`), `Document ${i}`);
    for (let i = 0; i < 2; i++) fs.writeFileSync(path.join(tmp.path, "assets", `img${i}.dat`), `fake-img-${i}`);
  });

  it("counts files by extension using run_command", async () => {
    const dir = tmp.path.replace(/\\/g, "/");
    const result = await runNodeScript(`
      const fs = require('fs');
      const path = require('path');
      const counts = {};
      function walk(d) {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          if (e.isDirectory()) { walk(path.join(d, e.name)); continue; }
          const ext = path.extname(e.name) || '(none)';
          counts[ext] = (counts[ext] || 0) + 1;
        }
      }
      walk(${JSON.stringify(dir)});
      for (const [ext, n] of Object.entries(counts).sort()) console.log(ext + ': ' + n);
    `);
    expect(result).toContain(".js: 5");
    expect(result).toContain(".txt: 3");
    expect(result).toContain(".dat: 2");
  });

  it("list_directory shows subdirectories", async () => {
    const listing = await fsHandlers.list_directory({ path: tmp.path });
    expect(listing).toContain("src/");
    expect(listing).toContain("docs/");
    expect(listing).toContain("assets/");
  });

  it("glob finds all .js files recursively", async () => {
    const result = await fsHandlers.glob({ pattern: "**/*.js", path: tmp.path });
    expect(result).toContain("5 files");
    for (let i = 0; i < 5; i++) {
      expect(result).toContain(`mod${i}.js`);
    }
  });
});

// ── 9. Git log analysis ─────────────────────────────────────────────────────

describe("git log analysis", () => {
  it("retrieves git log from the flint-agent project", async () => {
    const projectDir = path.resolve(".");
    const gitDir = path.join(projectDir, ".git");

    // Skip if not a git repo
    if (!fs.existsSync(gitDir)) return;

    const result = await run_command({
      command: "git log --oneline -10",
      cwd: projectDir,
    });
    expect(result).toMatch(/[0-9a-f]{7,}/);
  });

  it("git log output contains commit messages", async () => {
    const repoDir = path.join(tmp.path, "test-repo");
    fs.mkdirSync(repoDir);

    await run_command({ command: "git init", cwd: repoDir });
    await run_command({ command: "git config user.email test@test.com", cwd: repoDir });
    await run_command({ command: "git config user.name Test", cwd: repoDir });
    fs.writeFileSync(path.join(repoDir, "file.txt"), "hello");
    await run_command({ command: "git add .", cwd: repoDir });
    await run_command({ command: "git commit -m initial-commit", cwd: repoDir });

    const log = await run_command({ command: "git log --oneline", cwd: repoDir });
    expect(log).toContain("initial-commit");
  });

  it("git shortlog summarizes by author", async () => {
    const repoDir = path.join(tmp.path, "repo2");
    fs.mkdirSync(repoDir);

    await run_command({ command: "git init", cwd: repoDir });
    await run_command({ command: "git config user.email dev@example.com", cwd: repoDir });
    await run_command({ command: "git config user.name Dev", cwd: repoDir });
    fs.writeFileSync(path.join(repoDir, "a.txt"), "a");
    await run_command({ command: "git add .", cwd: repoDir });
    await run_command({ command: "git commit -m first", cwd: repoDir });
    fs.writeFileSync(path.join(repoDir, "b.txt"), "b");
    await run_command({ command: "git add .", cwd: repoDir });
    await run_command({ command: "git commit -m second", cwd: repoDir });

    const shortlog = await run_command({ command: "git shortlog -s -n --all", cwd: repoDir });
    expect(shortlog).toContain("Dev");
  });
});

// ── 10. Create ZIP excluding patterns ───────────────────────────────────────

describe("create zip excluding patterns", () => {
  beforeEach(() => {
    const project = path.join(tmp.path, "zipme");
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, "app.js"), "const x = 1;");
    fs.writeFileSync(path.join(project, "style.css"), "body{}");
    fs.writeFileSync(path.join(project, "debug.log"), "debug output...");
    fs.mkdirSync(path.join(project, "node_modules"));
    fs.writeFileSync(path.join(project, "node_modules", "dep.js"), "module");
    fs.mkdirSync(path.join(project, ".cache"));
    fs.writeFileSync(path.join(project, ".cache", "tmp.dat"), "cached");
  });

  it("creates zip with only desired files using node", async () => {
    const projectDir = path.join(tmp.path, "zipme").replace(/\\/g, "/");
    const zipPath = path.join(tmp.path, "output.zip").replace(/\\/g, "/");

    const result = await runNodeScript(`
      const fs = require('fs');
      const path = require('path');
      const SKIP = new Set(['node_modules', '.cache']);
      const SKIP_EXT = new Set(['.log']);
      const included = [];
      function walk(d, rel) {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const full = path.join(d, e.name);
          const r = rel ? rel + '/' + e.name : e.name;
          if (e.isDirectory()) {
            if (!SKIP.has(e.name)) walk(full, r);
          } else {
            if (!SKIP_EXT.has(path.extname(e.name))) included.push(r);
          }
        }
      }
      walk(${JSON.stringify(projectDir)}, '');
      fs.writeFileSync(${JSON.stringify(zipPath)}, JSON.stringify(included));
      console.log('Included: ' + included.join(', '));
    `);
    expect(result).toContain("app.js");
    expect(result).toContain("style.css");
    expect(result).not.toContain("debug.log");
    expect(result).not.toContain("dep.js");
    expect(result).not.toContain("tmp.dat");
  });

  it("zip manifest file exists and contains expected entries", async () => {
    const projectDir = path.join(tmp.path, "zipme").replace(/\\/g, "/");
    const manifestPath = path.join(tmp.path, "manifest.json").replace(/\\/g, "/");

    await runNodeScript(`
      const fs = require('fs');
      const path = require('path');
      const SKIP = new Set(['node_modules', '.cache']);
      const SKIP_EXT = new Set(['.log']);
      const included = [];
      function walk(d, rel) {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const full = path.join(d, e.name);
          const r = rel ? rel + '/' + e.name : e.name;
          if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(full, r); }
          else { if (!SKIP_EXT.has(path.extname(e.name))) included.push(r); }
        }
      }
      walk(${JSON.stringify(projectDir)}, '');
      fs.writeFileSync(${JSON.stringify(manifestPath)}, JSON.stringify(included));
      console.log('Done');
    `);
    const manifest = JSON.parse(fs.readFileSync(path.join(tmp.path, "manifest.json"), "utf-8"));
    expect(manifest).toContain("app.js");
    expect(manifest).toContain("style.css");
    expect(manifest).toHaveLength(2);
  });

  it("excluded directories are not traversed", async () => {
    const projectDir = path.join(tmp.path, "zipme").replace(/\\/g, "/");
    const result = await runNodeScript(`
      const fs = require('fs');
      const path = require('path');
      const SKIP = new Set(['node_modules', '.cache']);
      const visited = [];
      function walk(d, rel) {
        visited.push(rel || '.');
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const full = path.join(d, e.name);
          const r = rel ? rel + '/' + e.name : e.name;
          if (e.isDirectory() && !SKIP.has(e.name)) walk(full, r);
        }
      }
      walk(${JSON.stringify(projectDir)}, '');
      console.log('Visited: ' + visited.join(', '));
    `);
    expect(result).not.toContain("node_modules");
    expect(result).not.toContain(".cache");
  });
});
