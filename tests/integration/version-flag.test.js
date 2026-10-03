// --version prints the version and starts nothing, whichever entry point a
// host uses (node integration test, 2026-10-02: the node panel asked
// `flint --version` and got a console).
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const version = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).version;

describe("--version", () => {
  for (const entry of ["bin/flint.js", "src/launcher.js", "src/index.js"]) {
    it(`node ${entry} --version`, () => {
      const out = execFileSync(process.execPath, [path.join(ROOT, entry), "--version"], { encoding: "utf8", timeout: 30000, cwd: ROOT });
      expect(out.trim()).toBe(`flint ${version}`);
    });
  }
});
