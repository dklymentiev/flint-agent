// Path guard — beforeHook that blocks access to critical paths and detects secret files

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AGENT_SRC_DIR = path.resolve(__dirname, "..");

// Credential stores under the home directory. Guarded on their own, not via the
// denylist: .kube and .docker are not on it, and the denylist is configurable.
const SENSITIVE_DIRS = [".ssh", ".gnupg", ".aws", ".kube", ".docker"];

// Tools that access file paths
const PATH_TOOLS = new Set([
  "read_file", "write_file", "edit_file", "delete_file",
  "copy_file", "move_file", "create_directory",
  "list_directory", "glob", "search_in_files", "view_image",
]);

/**
 * Resolve a path, following symlinks to get the real target.
 * Falls back to path.resolve if realpathSync fails (file doesn't exist yet).
 */
function resolveReal(filePath) {
  try {
    return fs.realpathSync.native(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

/**
 * Extract file paths from tool args.
 */
function extractPaths(name, args) {
  const paths = [];
  if (args.path) paths.push(args.path);
  if (args.source) paths.push(args.source);
  if (args.destination) paths.push(args.destination);
  return paths;
}

/**
 * Check if a path matches a denylist entry.
 */
function isDenied(resolved, denylist) {
  // Windows paths are case-insensitive: c:\WINDOWS is C:\Windows.
  const fold = process.platform === "win32" ? (p) => p.toLowerCase() : (p) => p;
  const r = fold(resolved);
  for (const denied of denylist) {
    const deniedResolved = fold(path.resolve(denied));
    if (r === deniedResolved || r.startsWith(deniedResolved + path.sep)) {
      return denied;
    }
  }
  return null;
}

/**
 * Check if a filename matches secret file patterns.
 */
function isSecretFile(filePath, patterns) {
  const basename = path.basename(filePath);
  return patterns.some((re) => re.test(basename));
}

/**
 * Create a path-guard beforeHook.
 * @param {object} policy - Security policy from policies.js
 * @returns {Function} beforeHook(name, args)
 */
export function createPathGuardHook(policy) {
  // Combine critical denylist + agent src dir + extra deny paths
  const denylist = [
    AGENT_SRC_DIR,
    ...policy.criticalDenylist,
    ...( policy.extraDenyPaths || []),
  ];

  return function pathGuardHook(name, args) {
    if (!PATH_TOOLS.has(name)) return null;

    const rawPaths = extractPaths(name, args);
    if (!rawPaths.length) return null;

    for (const rawPath of rawPaths) {
      const resolved = resolveReal(rawPath);

      // os.homedir(), not process.env.HOME: HOME is unset on Windows, and
      // path.resolve(path.join("", ".ssh")) silently guards <cwd>\.ssh instead.
      // Read per call rather than once at module load so tests can repoint the home dir.
      const homeDir = os.homedir();
      const isSensitive = SENSITIVE_DIRS.some((dir) => {
        const dirPath = path.resolve(path.join(homeDir, dir));
        return resolved === dirPath || resolved.startsWith(dirPath + path.sep);
      });

      // Check critical denylist
      const deniedBy = isDenied(resolved, denylist);
      if (deniedBy) {
        // For read operations, allow listing but block writes to agent src
        const isRead = name === "read_file" || name === "list_directory" ||
                       name === "glob" || name === "search_in_files" || name === "view_image";

        // Always deny writing to critical paths
        if (!isRead) {
          return { deny: true, reason: `path "${resolved}" is protected (matches ${deniedBy})` };
        }

        // For reads of agent source, allow but log
        if (resolved.startsWith(AGENT_SRC_DIR)) {
          // Allow reading own source (useful for debugging) — no action needed
          return null;
        }
      }

      // Reading a credential store asks for confirmation whether or not the denylist
      // covers it. Previously this sat inside the denylist branch, so .kube and
      // .docker were never reached.
      // `key` is what an "always" answer may be recorded under: this tool
      // for this exact file, nothing wider.
      if (isSensitive) {
        return { confirm: true, reason: `it is a sensitive path ("${resolved}")`, key: `${name}:${resolved}` };
      }

      // Check for secret files — force confirm even if permission is "allow"
      if (policy.secretFilePatterns && isSecretFile(resolved, policy.secretFilePatterns)) {
        return {
          confirm: true,
          reason: `"${path.basename(resolved)}" matches the secret-file patterns and may contain secrets`,
          key: `${name}:${resolved}`,
        };
      }
    }

    return null;
  };
}
