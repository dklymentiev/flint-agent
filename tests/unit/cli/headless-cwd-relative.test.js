// Red test for relative --cwd resolution defect.
// enterCwd() is called twice (prepareHeadless + startHeadless).
// Without path.resolve, a relative --cwd chdirs from different base dirs
// on the second call, escaping the intended directory.
import { describe, it, expect } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
const cliPath = pathToFileURL(path.join(repoRoot, "src", "cli.js"));

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "flint-rel-"));

describe("parseCLI resolves relative --cwd to absolute", () => {
  it("parseCLI() returns an absolute cwd for relative --cwd", async () => {
    const targetDir = path.join(tmpBase, "proj");
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(path.join(targetDir, "marker.txt"), "ok");

    const origArgv = process.argv;
    const origCwd = process.cwd();

    process.chdir(tmpBase);
    process.argv = ["node", "flint", "--headless", "--cwd", "proj", "--task", "ls"];

    try {
      const cli = await import(cliPath);
      const parsed = cli.parseCLI();

      // Without fix: parsed.cwd = "proj" (relative)
      // With fix: parsed.cwd = absolute path
      expect(path.isAbsolute(parsed.cwd)).toBe(true);
      expect(parsed.cwd).toBe(path.resolve(tmpBase, "proj"));

      // Two enterCwd calls should resolve to the same directory
      const first = path.resolve(tmpBase, parsed.cwd);
      const second = path.resolve(first, parsed.cwd);
      expect(first).toBe(second);
    } finally {
      process.argv = origArgv;
      process.chdir(origCwd);
    }
  });

  it("parseCLI() returns absolute cwd for relative --cwd with nested path", async () => {
    const nestedDir = path.join(tmpBase, "sub", "inner");
    fs.mkdirSync(nestedDir, { recursive: true });

    const origArgv = process.argv;
    const origCwd = process.cwd();

    process.chdir(tmpBase);
    process.argv = ["node", "flint", "--headless", "--cwd", "sub/inner", "--task", "ls"];

    try {
      const cli = await import(cliPath);
      const parsed = cli.parseCLI();

      expect(path.isAbsolute(parsed.cwd)).toBe(true);
      expect(parsed.cwd).toBe(path.resolve(tmpBase, "sub", "inner"));

      // Simulate two enterCwd() calls: both should land in the same absolute dir
      const first = path.resolve(tmpBase, parsed.cwd);
      const second = path.resolve(first, parsed.cwd);
      expect(first).toBe(second);
    } finally {
      process.argv = origArgv;
      process.chdir(origCwd);
    }
  });
});
