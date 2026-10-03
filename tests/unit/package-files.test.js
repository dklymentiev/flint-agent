// What `npm install flint-agent` gets. system.md, Flint's own prompt, was
// left out of "files": installed from npm, Flint would have started with a
// one-line fallback prompt (found 2026-10-02 before the first npm release).
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
const shipped = (p) => pkg.files.some((f) => f === p || (f.endsWith("/") && p.startsWith(f)));

describe("the npm package", () => {
  it("ships every file Flint reads at run time from its own folder", () => {
    for (const p of ["system.md", "README.md", "config/classifier-prompt.md", "profiles/profiles.json", "bin/flint.js", "src/index.js", "patches/ink+6.8.0.patch"]) {
      expect(existsSync(new URL(`../../${p}`, import.meta.url)), `${p} exists`).toBe(true);
      expect(shipped(p), `${p} is in package.json "files"`).toBe(true);
    }
  });

  it("has the flint command", () => {
    expect(pkg.bin.flint).toBe("./bin/flint.js");
  });
});
