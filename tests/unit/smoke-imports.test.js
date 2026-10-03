// Smoke test: verify all src/ modules can be imported without syntax errors
// Catches issues like `await` in non-async functions, missing imports, etc.
import { describe, it, expect } from "vitest";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";

const SRC_DIR = path.resolve("src");

function collectJsFiles(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectJsFiles(full, files);
    } else if (entry.endsWith(".js")) {
      files.push(full);
    }
  }
  return files;
}

// Modules that need runtime environment (Ink/React components, etc.) — skip dynamic import
const SKIP_PATTERNS = [
  /components\//, // React/Ink components need JSX runtime
  /index\.js$/,   // Main entrypoint starts the app
];

describe("smoke: all src modules importable", () => {
  const files = collectJsFiles(SRC_DIR);
  const testable = files.filter(f => !SKIP_PATTERNS.some(p => p.test(f.replace(/\\/g, "/"))));

  for (const file of testable) {
    const rel = path.relative(SRC_DIR, file).replace(/\\/g, "/");
    it(`src/${rel}`, async () => {
      // Dynamic import should not throw SyntaxError or import errors
      await expect(import(file)).resolves.toBeDefined();
    });
  }
});
