// --help prints the usage and starts nothing, with or without a terminal.
// Before: the flag fell through to a normal start, which on a machine without a
// key opened the first-run wizard and waited for a provider number forever
// when stdin was a pipe or /dev/null (startup matrix, 2026-10-08).
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function run(entry, flag, input) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "flint-help-"));
  const env = { ...process.env, HOME: home, USERPROFILE: home, FLINT_DATA_DIR: path.join(home, "data") };
  for (const k of Object.keys(env)) if (/API_KEY/i.test(k)) delete env[k];
  try {
    return spawnSync(process.execPath, [path.join(ROOT, entry), flag], {
      encoding: "utf8", timeout: 15000, cwd: home, env, input, killSignal: "SIGKILL",
    });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

describe("--help", () => {
  for (const entry of ["bin/flint.js", "src/launcher.js", "src/index.js"]) {
    for (const flag of ["--help", "-h"]) {
      it(`node ${entry} ${flag} with empty stdin and no key`, () => {
        const r = run(entry, flag, "");
        expect(r.error).toBeUndefined();
        expect(r.status).toBe(0);
        expect(r.stdout).toMatch(/Usage:/);
        expect(r.stdout).toMatch(/--headless/);
        expect(r.stdout).not.toMatch(/Choose provider/);
      }, 30000);
    }
  }
});
