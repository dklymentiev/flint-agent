import fs from "node:fs/promises";
import { readFileSync, statSync, createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import os from "node:os";
import { config } from "../config.js";
import { saveCheckpoint } from "./checkpoint.js";

/**
 * Normalize /tmp/ paths to os.tmpdir() for cross-platform consistency.
 * On Linux/Mac: /tmp/ stays /tmp/ (os.tmpdir() = /tmp)
 * On Windows: /tmp/foo → C:\Users\...\AppData\Local\Temp\foo
 * Without this, Node.js resolves /tmp/ to C:\tmp\ on Windows,
 * but shells (Git Bash) resolve to AppData\Local\Temp — causing split-brain.
 */
export function normalizeTmpPath(filePath) {
  // Only fix on Windows where /tmp/ diverges
  if (process.platform !== "win32") return filePath;
  const normalized = filePath.replace(/\\/g, "/");
  if (normalized.startsWith("/tmp/") || normalized === "/tmp") {
    const rest = normalized.slice(5); // after "/tmp/"
    return path.join(os.tmpdir(), rest);
  }
  return filePath;
}

/**
 * On Windows, Git Bash interprets /c/Projects/x as drive C:\Projects\x.
 * Node.js path.resolve treats /c/ as a literal "c" subdirectory of the
 * current drive root, so /c/Projects/x resolves to C:\c\Projects\x — a
 * different folder. This is the split-brain bug: run_command (bash) and
 * file tools (Node fs) agree on neither the location nor that they differ.
 *
 * On Linux/macOS /c/ is a real absolute path and must not be touched.
 *
 * Returns an error message string when the path is a shell-style /drive/ path
 * on Windows, or null when the path is fine.
 */
export function shellPathError(filePath) {
  if (process.platform !== "win32") return null;
  const normalized = filePath.replace(/\\/g, "/");
  // Match /c/... , /D/something, etc. — a leading slash then a single
  // letter then a slash, like Git Bash /drive-letter syntax.
  if (/^\/[a-zA-Z]\//.test(normalized)) {
    const drive = normalized[1].toUpperCase();
    return `On Windows, use drive-letter paths like "C:/.../" or "C:\\...\\" instead of "/${normalized[1]}/...". The /${normalized[1]}/ form is a shell-ism (Git Bash only): Node.js resolves it to a literal "C:\\${normalized[1]}\\..." subdirectory, not drive ${drive}:.`;
  }
  return null;
}

// Denied paths — agent cannot write to these directories (e.g. its own source)
// Inherited from parent agent via AGENT_DENIED_PATHS env var
let deniedPaths = (process.env.AGENT_DENIED_PATHS || "")
  .split(",")
  .map((p) => p.trim())
  .filter(Boolean)
  .map((p) => path.resolve(p));

export function setDeniedPaths(paths) {
  deniedPaths = paths.map((p) => path.resolve(p));
}

export function getDeniedPaths() {
  return deniedPaths;
}

export function clearDeniedPaths() {
  deniedPaths = [];
}

// Resolve path for READING — relative to project root (can read anything).
// config.baseDir moves it, and the folder commands run in (process-tools),
// without moving projectRoot, which also locates Flint's own code for child
// agents: the stdio mode sets it to the agent's folder, where an agent's
// relative paths and commands would go.
function resolveReadPath(filePath) {
  filePath = normalizeTmpPath(filePath);
  if (path.isAbsolute(filePath)) return path.resolve(filePath);
  const root = config.baseDir || config.projectRoot || process.cwd();
  return path.resolve(root, filePath);
}

// Resolve path for WRITING — relative to workspace (isolated per session)
function resolveWritePath(filePath) {
  filePath = normalizeTmpPath(filePath);
  if (path.isAbsolute(filePath)) return path.resolve(filePath);
  const workdir = config.workdir || process.cwd();
  // Strip leading "workspace/" if workdir already IS the workspace dir
  // Models see "workspace/" in list_directory and include it in paths,
  // but workdir already points to .../workspace/ → double nesting
  const workspaceName = path.basename(workdir);
  if (filePath.startsWith(workspaceName + "/") || filePath.startsWith(workspaceName + "\\")) {
    filePath = filePath.slice(workspaceName.length + 1);
  }
  return path.resolve(workdir, filePath);
}

// Default resolve (backward compat) — uses read path
function resolvePath(filePath) {
  return resolveReadPath(filePath);
}

/** Guard against shell-style /drive/ paths on Windows. Returns an error string
 * if the path uses Git Bash /c/... syntax (which Node resolves to a literal
 * "C:\c\..." subdirectory, not drive C:), or null if the path is fine.
 * This is the single chokepoint: deleting the shellPathError call inside
 * guardShellPath makes the check a no-op and tests go red. */
function guardShellPath(filePath) {
  const err = shellPathError(filePath || "");
  return err;
}

function checkAccess(filePath, opts) {
  // When checking a write path, resolve with resolveWritePath (relative to
  // workdir) instead of resolveReadPath (relative to baseDir/projectRoot).
  // This prevents write_file from escaping allowedPaths due to resolution
  // divergence between read and write paths. Deleting the opts.forWrite
  // check reverts to the read path — write checks could be bypassed.
  const resolved = (opts && opts.forWrite) ? resolveWritePath(filePath) : resolvePath(filePath);

  // Check deny-list first (e.g. Flint's own source during /auto)
  if (deniedPaths.length) {
    const denied = deniedPaths.some((dir) => resolved.startsWith(dir + path.sep) || resolved === dir);
    if (denied) {
      throw new Error(`Access denied: "${resolved}" is a protected directory (self-modification blocked)`);
    }
  }

  // Check allow-list
  const allowed = config.allowedPaths;
  if (!allowed || !allowed.length) return; // unrestricted
  const ok = allowed.some((dir) => resolved.startsWith(dir + path.sep) || resolved === dir);
  if (!ok) {
    throw new Error(`Access denied: "${resolved}" is outside allowed directories [${allowed.join(", ")}]`);
  }
}

export const tools = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the contents of a file. Files up to 256 KB (any ordinary source file) are returned in full: read them whole in one call, not in slices. For larger files, a preview is shown with file stats (size, lines, estimated tokens); use offset/limit to read the rest in chunks of 1000 lines.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to the file to read" },
          offset: { type: "integer", description: "Start line number (0-based). Use for large files or to continue reading." },
          limit: { type: "integer", description: "Max number of lines to read (default: 1000)." },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write files to disk. For 1 file: pass path and content. For multiple files: pass files array. Each call = 1 iteration — always batch when creating 2+ files. For temporary/scratch files use /tmp/ paths — they redirect to the OS temp directory and won't appear in git status.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path. For temporary/scratch files use /tmp/ — on Windows this redirects to the OS temp dir, keeping scratch files out of git status. Relative paths resolve into the task repository." },
          content: { type: "string", description: "File content (single-file mode)" },
          files: {
            type: "array",
            items: {
              type: "object",
              properties: {
                path: { type: "string" },
                content: { type: "string" },
              },
              required: ["path", "content"],
            },
            description: "Batch mode: [{path, content}, ...] — use for 2+ files",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_directory",
      description: "List files and directories at the given path",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to the directory to list" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_directory",
      description: "Create a directory (and parent directories if needed)",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path of the directory to create" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "copy_file",
      description: "Copy a file from source path to destination path",
      parameters: {
        type: "object",
        properties: {
          source: { type: "string", description: "Source file path" },
          destination: { type: "string", description: "Destination file path" },
        },
        required: ["source", "destination"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "move_file",
      description: "Move or rename a file from source path to destination path",
      parameters: {
        type: "object",
        properties: {
          source: { type: "string", description: "Source file path" },
          destination: { type: "string", description: "Destination file path" },
        },
        required: ["source", "destination"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_file",
      description: "Delete a file or empty directory. DESTRUCTIVE — always confirm with user first!",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to the file or empty directory to delete" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_in_files",
      description: "Search for a text pattern (regex) across files in a directory. Returns matching lines with file paths and line numbers. Use this to find specific code, functions, imports, patterns without reading entire files. Much cheaper than reading every file.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regex pattern to search for (e.g. 'function handleSubmit', 'import.*react', 'TODO')" },
          path: { type: "string", description: "Directory to search in (default: current dir)" },
          glob: { type: "string", description: "File glob filter (e.g. '*.js', '*.ts', '*.py'). Default: all text files" },
          max_results: { type: "number", description: "Maximum matches to return (default: 30)" },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "view_image",
      description: "View an image file. Returns image description and injects image into conversation for visual analysis. Supports: png, jpg, gif, webp, bmp.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to image file" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description: "Edit a file by replacing a specific text fragment. More precise than write_file — doesn't require rewriting the entire file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to the file to edit" },
          old_text: { type: "string", description: "Exact text to find and replace" },
          new_text: { type: "string", description: "Replacement text" },
          all: { type: "boolean", description: "Replace all occurrences (default: false)" },
        },
        required: ["path", "old_text", "new_text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "glob",
      description: "Find files matching a glob pattern. Supports: *, **, ?. Example: 'src/**/*.js', '*.md'.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Glob pattern" },
          path: { type: "string", description: "Base directory (default: current dir)" },
        },
        required: ["pattern"],
      },
    },
  },
];

export const handlers = {
  async read_file({ path: filePath, offset, limit }) {
    const shellErr = guardShellPath(filePath);
    if (shellErr) return shellErr;
    checkAccess(filePath, { forWrite: false });
    // Same base as write_file, so a file the agent just wrote is found. A
    // relative path that only exists under the old read base (baseDir or the
    // install root) is still read from there instead of failing.
    let resolved = resolveWritePath(filePath);
    if (!path.isAbsolute(normalizeTmpPath(filePath))) {
      const legacy = resolveReadPath(filePath);
      if (legacy !== resolved && !(await fs.access(resolved).then(() => true, () => false))
          && await fs.access(legacy).then(() => true, () => false)) {
        resolved = legacy;
      }
    }
    const ext = path.extname(resolved).toLowerCase();
    const binaryExts = [".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".ico", ".svg",
      ".mp3", ".mp4", ".wav", ".avi", ".mkv", ".mov", ".flac",
      ".zip", ".rar", ".7z", ".tar", ".gz", ".bz2",
      ".exe", ".dll", ".so", ".bin", ".dat", ".pdf",
      ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx"];
    if (binaryExts.includes(ext)) {
      const stat = await fs.stat(resolved);
      return `[Binary file: ${resolved} (${(stat.size / 1024).toFixed(1)} KB, type: ${ext}). Cannot read binary files as text.]`;
    }

    const MAX_SIZE = 512 * 1024; // 512 KB — small enough to read into memory
    const MAX_LINES = 1000;
    const PREVIEW_LINES = 20; // auto-preview for large files
    const stat = await fs.stat(resolved);
    const isLarge = stat.size > MAX_SIZE;

    // Large file: always use streaming (never load into memory)
    if (isLarge) {
      const start = Math.max(0, offset || 0);
      const count = limit || PREVIEW_LINES; // default to preview, not 1000
      const { lines, totalLines } = await readLinesStream(resolved, start, count);

      const sizeMB = (stat.size / 1024 / 1024).toFixed(1);
      const sizeGB = stat.size > 1024 * 1024 * 1024
        ? ` (${(stat.size / 1024 / 1024 / 1024).toFixed(2)} GB)` : "";

      let header = `[Large file: ${resolved} — ${sizeMB} MB${sizeGB}`;
      if (totalLines != null) header += `, ~${totalLines} lines`;
      header += `]\n`;

      if (!offset && !limit) {
        const estimatedTokens = Math.round(stat.size / 3.5);
        header += `[Auto-preview: first ${lines.length} lines. ~${estimatedTokens.toLocaleString()} tokens total.]\n`;
        header += `[IMPORTANT: Ask the user before reading the full file. Warn about size and estimated cost.]\n`;
        header += `[To read more: use read_file(path="${filePath}", offset=0, limit=1000) and continue in chunks.]\n\n`;
      }

      let result = header + lines.join("\n");

      if (start + count < (totalLines || Infinity)) {
        result += `\n[... showing lines ${start + 1}-${start + lines.length}` +
          (totalLines != null ? ` of ${totalLines}` : "") +
          `. Use offset=${start + lines.length} limit=${count} to continue.]`;
      }
      return result;
    }

    // Small file: read into memory (safe)
    const content = await fs.readFile(resolved, "utf-8");

    if (offset != null || limit != null) {
      const lines = content.split("\n");
      const start = Math.max(0, offset || 0);
      const count = limit || MAX_LINES;
      const slice = lines.slice(start, start + count);
      let result = slice.join("\n");
      if (start + count < lines.length) {
        result += `\n[... showing lines ${start + 1}-${start + count} of ${lines.length} total. Use offset=${start + count} to continue.]`;
      }
      return result;
    }

    // The limit is in bytes, not lines: 1000 lines of source is ~50 KB, ~15k
    // tokens, cheap to read whole. A line limit caught ordinary files like
    // agent.js and made the model read them in 20-line slices, one slow model
    // call each. No "ask the user" here: under a task nobody is there
    // to answer, and at this size the cost is not worth a question.
    const FULL_READ_BYTES = 256 * 1024;
    if (stat.size > FULL_READ_BYTES) {
      const lineCount = content.split("\n").length;
      const previewLines = 50;
      const preview = content.split("\n").slice(0, previewLines).join("\n");
      const sizeKB = (stat.size / 1024).toFixed(1);
      const estimatedTokens = Math.round(stat.size / 3.5); // ~3.5 bytes per token for mixed content
      return preview + `\n\n[FILE PREVIEW: ${resolved}]\n` +
        `[Total: ${lineCount} lines, ${sizeKB} KB, ~${estimatedTokens.toLocaleString()} tokens]\n` +
        `[Showing first ${previewLines} lines. Full file NOT loaded.]\n` +
        `[To read more: use read_file(path="${filePath}", offset=${previewLines}, limit=${MAX_LINES}) and continue in chunks.]`;
    }

    return content;
  },

  async write_file({ path: filePath, content, files }) {
    // Normalize: if model passed path+content instead of files[], wrap it
    if (!files && filePath && content != null) {
      files = [{ path: filePath, content }];
    }
    if (!files || !files.length) return "Error: files array is required. Example: write_file({files: [{path: 'a.js', content: '...'}]})";
    if (files.length > config.maxBatchFiles) return `Error: max ${config.maxBatchFiles} files per call`;
    const results = [];
    const writtenTo = [];
    for (const { path: fp, content: fc } of files) {
      const shellErr = guardShellPath(fp);
      if (shellErr) {
        results.push(`✗ ${fp}: ${shellErr}`);
        continue;
      }
      try {
        checkAccess(fp, { forWrite: true });
        await saveCheckpoint(fp, "write");
        const resolved = resolveWritePath(fp);
        await fs.mkdir(path.dirname(resolved), { recursive: true });
        await fs.writeFile(resolved, fc, "utf-8");
        results.push(`✓ ${fp}`);
        writtenTo.push(resolved);
      } catch (err) {
        results.push(`✗ ${fp}: ${err.message}`);
      }
    }
    if (files.length === 1) return results[0].startsWith("✓") ? `File written: ${writtenTo[0]}` : results[0];
    return `${results.filter(r => r.startsWith("✓")).length}/${files.length} files written:\n${results.join("\n")}`;
  },

  async list_directory({ path: dirPath }) {
    const shellErr = guardShellPath(dirPath);
    if (shellErr) return shellErr;
    checkAccess(dirPath);
    const resolved = resolvePath(dirPath);
    const entries = await fs.readdir(resolved, { withFileTypes: true });
    const lines = entries.map((e) => {
      const suffix = e.isDirectory() ? "/" : "";
      return `${e.name}${suffix}`;
    });
    return lines.join("\n");
  },

  async create_directory({ path: dirPath }) {
    const shellErr = guardShellPath(dirPath);
    if (shellErr) return shellErr;
    try {
      checkAccess(dirPath, { forWrite: true });
    } catch (err) {
      return err.message;
    }
    const resolved = resolveWritePath(dirPath);
    await fs.mkdir(resolved, { recursive: true });
    return `Directory created: ${resolved}`;
  },

  async copy_file({ source, destination }) {
    const shellErrS = guardShellPath(source);
    if (shellErrS) return shellErrS;
    const shellErrD = guardShellPath(destination);
    if (shellErrD) return shellErrD;
    try {
      checkAccess(source, { forWrite: true });
      checkAccess(destination, { forWrite: true });
    } catch (err) {
      return err.message;
    }
    const src = resolvePath(source);
    const dst = resolveWritePath(destination);
    await fs.mkdir(path.dirname(dst), { recursive: true });
    await fs.copyFile(src, dst);
    return `File copied: ${src} -> ${dst}`;
  },

  async move_file({ source, destination }) {
    const shellErrS = guardShellPath(source);
    if (shellErrS) return shellErrS;
    const shellErrD = guardShellPath(destination);
    if (shellErrD) return shellErrD;
    try {
      checkAccess(source, { forWrite: true });
      checkAccess(destination, { forWrite: true });
    } catch (err) {
      return err.message;
    }
    const src = resolvePath(source);
    const dst = resolveWritePath(destination);
    await fs.mkdir(path.dirname(dst), { recursive: true });
    await fs.rename(src, dst);
    return `File moved: ${src} -> ${dst}`;
  },

  async search_in_files({ pattern, path: searchPath, glob: globPattern, max_results: maxResults = 30 }) {
    const shellErr = guardShellPath(searchPath);
    if (shellErr) return shellErr;
    checkAccess(searchPath || ".");
    const dir = resolvePath(searchPath || ".");
    const regex = new RegExp(pattern, "i");
    const matches = [];
    const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "dist", "build", "__pycache__", ".cache"]);
    const BINARY_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".ico",
      ".mp3", ".mp4", ".wav", ".zip", ".rar", ".7z", ".tar", ".gz",
      ".exe", ".dll", ".so", ".bin", ".dat", ".pdf", ".woff", ".woff2", ".ttf",
      ".lock"]);

    // Fail-fast constraints: overall timeout + per-file size cap.
    // Without these, a single 500MB log file or a pathological tree can hang
    // the agent forever. 15s timeout, 2MB per-file cap. Bail cleanly.
    const TIMEOUT_MS = 15000;
    const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2 MB
    const deadline = Date.now() + TIMEOUT_MS;
    let timedOut = false;

    // The glob filters by extension: "*.js", "**/*.js" and "*.{js,ts,mjs}".
    // Braces used to fall through to a literal comparison that matched no
    // extension at all, so the tool answered "No matches" for code that was
    // there, and on 2026-09-22 the agent believed it for three calls. A shape
    // this cannot read is refused out loud instead of silently.
    let globExts = null;
    if (globPattern) {
      const base = globPattern.split("/").pop();
      const m = base.match(/^\*\.(?:\{([^{}]+)\}|([^*{}]+))$/);
      if (!m) {
        return `Error: glob "${globPattern}" is not supported. Use "*.ext" or "*.{ext1,ext2}", or omit glob and narrow the path.`;
      }
      const list = m[1] ? m[1].split(",") : [m[2]];
      globExts = new Set(list.map(e => "." + e.trim().toLowerCase()).filter(e => e.length > 1));
    }

    async function walk(dir) {
      if (matches.length >= maxResults) return;
      if (Date.now() > deadline) { timedOut = true; return; }
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch { return; }

      for (const entry of entries) {
        if (matches.length >= maxResults) return;
        if (Date.now() > deadline) { timedOut = true; return; }
        const full = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name)) await walk(full);
          continue;
        }

        const ext = path.extname(entry.name).toLowerCase();
        if (BINARY_EXTS.has(ext)) continue;
        // endsWith, not extname: "*.test.js" names a suffix with a dot in it.
        if (globExts && ![...globExts].some(e => entry.name.toLowerCase().endsWith(e))) continue;

        try {
          // Skip huge files — regex on 100MB text blocks the event loop.
          const stat = await fs.stat(full);
          if (stat.size > MAX_FILE_SIZE) continue;
          const content = await fs.readFile(full, "utf-8");
          const lines = content.split("\n");
          for (let i = 0; i < lines.length; i++) {
            if (matches.length >= maxResults) break;
            if (regex.test(lines[i])) {
              const rel = path.relative(resolvePath("."), full).replace(/\\/g, "/");
              matches.push(`${rel}:${i + 1}: ${lines[i].trimEnd().slice(0, 200)}`);
            }
          }
        } catch { /* skip unreadable */ }
      }
    }

    await walk(dir);

    const timeoutNote = timedOut ? " (TIMEOUT after 15s — try narrower path/glob)" : "";
    if (!matches.length) return `No matches for /${pattern}/ in ${dir}${timeoutNote}`;
    const header = `Found ${matches.length}${matches.length >= maxResults ? "+" : ""} matches for /${pattern}/${timeoutNote}:`;
    return header + "\n" + matches.join("\n");
  },

  async view_image({ path: filePath }) {
    const shellErr = guardShellPath(filePath);
    if (shellErr) return shellErr;
    checkAccess(filePath);
    const resolved = resolvePath(filePath);
    const ext = path.extname(resolved).toLowerCase().replace(".", "");
    const mimeMap = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp" };
    const mime = mimeMap[ext];
    if (!mime) return `Error: unsupported image format "${ext}". Supported: png, jpg, gif, webp, bmp`;
    const stat = statSync(resolved);
    const data = readFileSync(resolved);
    const base64 = data.toString("base64");
    const dataUrl = `data:${mime};base64,${base64}`;
    return { _image: true, data: base64, format: ext, text: `Image loaded: ${(stat.size / 1024).toFixed(1)} KB, ${ext}` };
  },

  async edit_file({ path: filePath, old_text, new_text, all }) {
    const shellErr = guardShellPath(filePath);
    if (shellErr) return shellErr;
    checkAccess(filePath, { forWrite: true });
    await saveCheckpoint(filePath, "edit");
    const resolved = resolveWritePath(filePath);
    const content = await fs.readFile(resolved, "utf-8");

    // Normalize line endings for matching. Files checked out on Windows
    // have CRLF, but the agent reads/displays content as LF (most model
    // responses and read_file outputs use LF). Strict includes() would
    // fail on any multi-line old_text because \r\n ≠ \n. Normalize both
    // sides, match, then write back in the file's original convention.
    const hasCRLF = /\r\n/.test(content);
    const contentN = content.replace(/\r\n/g, "\n");
    const oldN = String(old_text || "").replace(/\r\n/g, "\n");
    const newN = String(new_text || "").replace(/\r\n/g, "\n");

    if (!contentN.includes(oldN)) {
      // Give the agent concrete diagnostic info so it can self-correct.
      const firstLine = oldN.split("\n")[0].slice(0, 80);
      const firstLinePresent = firstLine && contentN.includes(firstLine);
      const hints = [
        `Error: old_text not found in ${filePath}.`,
        `- old_text length: ${oldN.length} chars, ${oldN.split("\n").length} lines`,
        `- file length: ${contentN.length} chars`,
        `- first line of old_text: ${JSON.stringify(firstLine)}`,
        `- that first line exists in file: ${firstLinePresent}`,
      ];
      if (firstLinePresent) {
        hints.push(`- hint: the first line matches but the rest doesn't — check indentation / trailing whitespace / blank lines in your old_text`);
      } else {
        hints.push(`- hint: re-read the file with read_file and copy the exact section you want to replace`);
      }
      return hints.join("\n");
    }

    const count = contentN.split(oldN).length - 1;
    const updatedN = all
      ? contentN.replaceAll(oldN, newN)
      : contentN.replace(oldN, newN);

    // Preserve original line-ending convention when writing back.
    const updated = hasCRLF ? updatedN.replace(/\n/g, "\r\n") : updatedN;

    await fs.writeFile(resolved, updated, "utf-8");
    return `Replaced ${all ? count : 1} occurrence(s) in ${filePath}`;
  },

  async glob({ pattern, path: basePath }) {
    const shellErr = guardShellPath(basePath);
    if (shellErr) return shellErr;
    checkAccess(basePath || ".");
    const base = resolvePath(basePath || ".");
    const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "dist", "build", "__pycache__", ".cache"]);
    const MAX_FILES = 200;
    const results = [];

    async function walk(dir, depth) {
      if (results.length >= MAX_FILES || depth > 20) return;
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch { return; }
      for (const entry of entries) {
        if (results.length >= MAX_FILES) return;
        const full = path.join(dir, entry.name);
        const rel = path.relative(base, full).replace(/\\/g, "/");
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name)) await walk(full, depth + 1);
        } else if (matchGlob(rel, pattern)) {
          results.push(rel);
        }
      }
    }

    await walk(base, 0);
    if (!results.length) return `No files matching "${pattern}" in ${base}`;
    return `${results.length}${results.length >= MAX_FILES ? "+" : ""} files:\n${results.join("\n")}`;
  },

  async delete_file({ path: filePath }) {
    const shellErr = guardShellPath(filePath);
    if (shellErr) return shellErr;
    checkAccess(filePath, { forWrite: true });
    await saveCheckpoint(filePath, "delete");
    const resolved = resolveWritePath(filePath);
    const stat = await fs.stat(resolved);
    if (stat.isDirectory()) {
      await fs.rmdir(resolved);
      return `Directory deleted: ${resolved}`;
    }
    await fs.unlink(resolved);
    return `File deleted: ${resolved}`;
  },
};

// Simple glob matcher: supports *, **, ?
function matchGlob(filePath, pattern) {
  // Convert glob pattern to regex
  let regex = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "*" && pattern[i + 1] === "*") {
      // ** matches any path segment(s)
      regex += ".*";
      i += 2;
      if (pattern[i] === "/") i++; // skip trailing slash after **
    } else if (ch === "*") {
      regex += "[^/]*";
      i++;
    } else if (ch === "?") {
      regex += "[^/]";
      i++;
    } else if (".+^${}()|[]\\".includes(ch)) {
      regex += "\\" + ch;
      i++;
    } else {
      regex += ch;
      i++;
    }
  }
  return new RegExp("^" + regex + "$").test(filePath);
}

/**
 * Stream-read specific lines from a file without loading it all into memory.
 * Stops reading as soon as requested lines are collected — does NOT scan the
 * entire file. Returns { lines: string[], totalLines: number|null }.
 */
function readLinesStream(filePath, startLine, count) {
  return new Promise((resolve, reject) => {
    const stream = createReadStream(filePath, { encoding: "utf-8" });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    const lines = [];
    let lineNum = 0;

    rl.on("line", (line) => {
      if (lineNum >= startLine && lines.length < count) {
        lines.push(line);
      }
      lineNum++;
      // Stop immediately once we have all requested lines
      if (lines.length >= count) {
        rl.close();
        stream.destroy();
      }
    });

    rl.on("close", () => {
      // totalLines is null — we didn't scan the whole file
      resolve({ lines, totalLines: null });
    });

    rl.on("error", reject);
    stream.on("error", (err) => {
      // stream.destroy() triggers ERR_STREAM_PREMATURE_CLOSE — that's expected
      if (err.code === "ERR_STREAM_PREMATURE_CLOSE") return;
      reject(err);
    });
  });
}
