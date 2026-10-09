// Each test drives the real handler. Delete the checkShellPathRadius call site
// and the corresponding test goes red.

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { createMockStore } from "../../helpers/mock-store.js";
import { config } from "../../../src/config.js";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

// Mock UI output functions — they write to terminal, not needed in tests
vi.mock("../../../src/ui/output.js", () => ({
  printProcessStart: vi.fn(),
  printProcessEnd: vi.fn(),
  printProcessSummary: vi.fn(),
  setProcessStream: vi.fn(),
}));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

let store;
let savedAllowedPaths;
let savedBaseDir;

beforeEach(() => {
  store = createMockStore();
  savedAllowedPaths = config.allowedPaths;
  savedBaseDir = config.baseDir;
  config.baseDir = config.projectRoot;
});

afterEach(() => {
  config.allowedPaths = savedAllowedPaths;
  config.baseDir = savedBaseDir;
});

afterAll(async () => {
  const fs = await import("node:fs");
  const testDir = path.join(REPO_ROOT, "tmp-inside");
  try { fs.rmSync(testDir, { recursive: true, force: true }); } catch {}
  // Clean up any temp files created by the radius tests
  const outsideBase = path.join(os.tmpdir(), "flint-radius-test");
  try { fs.rmSync(outsideBase, { recursive: true, force: true }); } catch {}
});

// Track temp files that tests create so we can clean them after each test
// even if a test that should have been blocked somehow let a command through.
let strayFiles = [];
afterEach(async () => {
  const fs = await import("node:fs");
  for (const f of strayFiles) {
    try { fs.rmSync(f, { force: true }); } catch {}
  }
  strayFiles = [];
});

async function getHandlers() {
  const { createProcessHandlers } = await import("../../../src/tools/process-tools.js");
  return createProcessHandlers(store);
}

function setAllowed(...dirs) {
  // Always include the cwd (projectRoot) so the cwd check passes and we
  // reach the command-text path extraction.
  config.allowedPaths = [config.projectRoot, ...dirs.map((p) => path.resolve(p))];
}

// Helpers for building paths that are "outside" the radius.
// Return the resolved (canonical) form so it matches the path the
// checkShellPathRadius error message reports. Tests that build shell
// commands from these use toForwardSlash() to keep Git Bash happy.
function outsidePath(...parts) {
  return path.resolve(path.join(os.tmpdir(), "flint-radius-test", ...parts));
}
// Convert a path to forward-slash form, safe for Git Bash redirection.
function toForwardSlash(p) {
  return p.replace(/\\/g, "/");
}

describe("shell path-radius: AGENT_ALLOWED_PATHS gates command text paths", () => {
  // --- The six example commands from the bug report ---

  it("blocks rm -rf with an out-of-radius path", async () => {
    const inside = path.join(REPO_ROOT, "tmp-inside");
    const outside = outsidePath("x");
    setAllowed(inside);
    const h = await getHandlers();
    const result = await h.run_command({ command: `rm -rf ${outside}` });
    expect(result).toContain("Error");
    expect(result).toContain("outside allowed");
    expect(result).toContain(outside);
  });

  it("blocks cp with an out-of-radius destination", async () => {
    const inside = path.join(REPO_ROOT, "tmp-inside");
    const outside = outsidePath("b.txt");
    setAllowed(inside);
    const h = await getHandlers();
    const result = await h.run_command({ command: `cp a.txt ${outside}` });
    expect(result).toContain("Error");
    expect(result).toContain("outside allowed");
    expect(result).toContain(outside);
  });

  it("blocks rm after && (multi-command chain)", async () => {
    const inside = path.join(REPO_ROOT, "tmp-inside");
    const outside = outsidePath("y");
    setAllowed(inside);
    const h = await getHandlers();
    const result = await h.run_command({ command: `cd ${REPO_ROOT} && rm -rf ${outside}` });
    expect(result).toContain("Error");
    expect(result).toContain("outside allowed");
    expect(result).toContain(outside);
  });

  it("blocks sed with flag and out-of-radius path", async () => {
    const inside = path.join(REPO_ROOT, "tmp-inside");
    const outside = outsidePath("z.js");
    setAllowed(inside);
    const h = await getHandlers();
    const result = await h.run_command({ command: `sed -i 's/a/b/' ${outside}` });
    expect(result).toContain("Error");
    expect(result).toContain("outside allowed");
    expect(result).toContain(outside);
  });

  it("blocks bash -c with nested out-of-radius path", async () => {
    const inside = path.join(REPO_ROOT, "tmp-inside");
    const outside = outsidePath("q");
    setAllowed(inside);
    const h = await getHandlers();
    const result = await h.run_command({ command: `bash -c 'rm -rf ${outside}'` });
    expect(result).toContain("Error");
    expect(result).toContain("outside allowed");
    expect(result).toContain(outside);
  });

  it("blocks echo redirection to out-of-radius path", async () => {
    const inside = path.join(REPO_ROOT, "tmp-inside");
    const outside = outsidePath("w.txt");
    setAllowed(inside);
    const h = await getHandlers();
    const result = await h.run_command({ command: `echo hi > ${outside}` });
    expect(result).toContain("Error");
    expect(result).toContain("outside allowed");
    expect(result).toContain(outside);
  });

  // --- Cases that should pass (not be blocked) ---

  it("does not block when AGENT_ALLOWED_PATHS is unset (backward compat)", async () => {
    config.allowedPaths = [];
    const h = await getHandlers();
    const result = await h.run_command({ command: "echo backwards-compat-ok" });
    expect(result.trim()).toBe("backwards-compat-ok");
  });

  it("allows a command entirely within allowed dirs", async () => {
    const inside = path.join(REPO_ROOT, "tmp-inside");
    const fs = await import("node:fs");
    fs.mkdirSync(inside, { recursive: true });
    // Use forward-slash path in the command so Git Bash handles it
    const target = toForwardSlash(path.join(inside, "ok.txt"));
    setAllowed(inside);
    const h = await getHandlers();
    const result = await h.run_command({ command: `echo hello > ${target}` });
    expect(result).not.toMatch(/^Error.*outside allowed/);
    try { fs.rmSync(path.join(inside, "ok.txt"), { force: true }); } catch {}
  });

  it("blocks chain with ; separator", async () => {
    const inside = path.join(REPO_ROOT, "tmp-inside");
    const outside = outsidePath("r.txt");
    setAllowed(inside);
    const h = await getHandlers();
    const result = await h.run_command({ command: `echo a > ${inside}/safe.txt; rm ${outside}` });
    expect(result).toContain("Error");
    expect(result).toContain("outside allowed");
    expect(result).toContain(outside);
  });

  it("blocks pipe with out-of-radius argument", async () => {
    const inside = path.join(REPO_ROOT, "tmp-inside");
    const outside = outsidePath("r2.txt");
    setAllowed(inside);
    const h = await getHandlers();
    const result = await h.run_command({ command: `cat ${outside} | head` });
    expect(result).toContain("Error");
    expect(result).toContain("outside allowed");
    expect(result).toContain(outside);
  });

  it("blocks absolute Unix path argument (cat /etc/passwd)", async () => {
    const inside = path.join(REPO_ROOT, "tmp-inside");
    setAllowed(inside);
    const h = await getHandlers();
    const result = await h.run_command({ command: "cat /etc/passwd" });
    expect(result).toContain("Error");
    expect(result).toContain("outside allowed");
  });

  it("blocks run_background_command with an out-of-radius path", async () => {
    const inside = path.join(REPO_ROOT, "tmp-inside");
    const outside = outsidePath("outside-bg.txt");
    setAllowed(inside);
    const h = await getHandlers();
    const result = await h.run_background_command({ command: `echo hello > ${outside}` });
    expect(result).toContain("Error");
    expect(result).toContain(outside);
  });

  it("includes the allowed list in the error message", async () => {
    const inside1 = path.join(REPO_ROOT, "tmp-inside");
    const inside2 = outsidePath("allowed");
    const outside = outsidePath("passwd");
    setAllowed(inside1, inside2);
    const h = await getHandlers();
    const result = await h.run_command({ command: `cat ${outside}` });
    expect(result).toContain("outside allowed");
    expect(result).toContain(inside1);
    expect(result).toContain(inside2);
  });

  it("skips paths containing variable references ($VAR)", async () => {
    const inside = path.join(REPO_ROOT, "tmp-inside");
    setAllowed(inside);
    const h = await getHandlers();
    const result = await h.run_command({ command: "echo $OUTSIDE_VAR" });
    expect(result).not.toMatch(/^Error.*outside allowed/);
  });

  // --- Case-insensitive comparison on Windows ---
  // On Windows, the filesystem is case-insensitive: C:\Projects and
  // c:\projects are the same directory. The path-radius check must not
  // reject a cwd or command path just because the drive letter or directory
  // casing differs from the configured allowedPaths.
  // These tests are no-ops on Linux where case matters.

  it("allows cwd with different drive-letter case and slash direction", async () => {
    if (process.platform !== "win32") return; // skip on Linux
    const inside = path.join(REPO_ROOT, "tmp-inside");
    setAllowed(inside);
    const h = await getHandlers();
    // cwd reported by Git Bash is lowercase with forward slashes
    const result = await h.run_command({
      command: "echo case-mismatch-cwd",
      cwd: REPO_ROOT.toLowerCase().replace(/\\/g, "/"),
    });
    expect(result).not.toMatch(/^Error.*outside allowed/);
  });

  it("allows command-path inside allowed dir with different casing", async () => {
    if (process.platform !== "win32") return;
    const inside = path.join(REPO_ROOT, "tmp-inside");
    const fs = await import("node:fs");
    fs.mkdirSync(inside, { recursive: true });
    const target = path.join(inside, "ok-case.txt");
    // Embed the path with different case than REPO_ROOT
    const mixedCaseTarget = toForwardSlash(target).replace(
      REPO_ROOT.toLowerCase().replace(/\\/g, "/"),
      REPO_ROOT.toUpperCase().replace(/\\/g, "/")
    );
    setAllowed(inside);
    const h = await getHandlers();
    const result = await h.run_command({ command: `echo hello > ${mixedCaseTarget}` });
    expect(result).not.toMatch(/^Error.*outside allowed/);
    try { fs.rmSync(target, { force: true }); } catch {}
  });

  it("blocks command-path outside allowed dir even with case difference", async () => {
    if (process.platform !== "win32") return;
    const inside = path.join(REPO_ROOT, "tmp-inside");
    const outside = toForwardSlash(outsidePath("case-out.txt"));
    setAllowed(inside);
    const h = await getHandlers();
    const result = await h.run_command({ command: `cat ${outside}` });
    expect(result).toContain("Error");
    expect(result).toContain("outside allowed");
  });
});
