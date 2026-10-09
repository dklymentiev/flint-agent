import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const flagModule = path.resolve("src", "data-dir-flag.js");

function run(args, env) {
  const base = { ...process.env, ...env };
  if (env.FLINT_DATA_DIR === undefined) delete base.FLINT_DATA_DIR;
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "flint-ddf-"));
  const code = "await import(process.argv[1]); console.log(process.env.FLINT_DATA_DIR ?? '');";
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code, pathToFileURL(flagModule).href, ...args],
    { cwd, env: base, encoding: "utf8" });
  return { out: r.stdout.trim(), cwd };
}

describe("data-dir-flag", () => {
  it("--data-dir sets FLINT_DATA_DIR, made absolute against the start cwd", () => {
    const { out, cwd } = run(["--data-dir", "rel-data"], {});
    expect(out).toBe(path.join(cwd, "rel-data"));
  });

  it("a relative FLINT_DATA_DIR from the environment is made absolute too", () => {
    const { out, cwd } = run([], { FLINT_DATA_DIR: "rel-env" });
    expect(out).toBe(path.join(cwd, "rel-env"));
  });

  it("the environment wins over the flag", () => {
    const abs = path.join(os.tmpdir(), "flint-env-wins");
    expect(run(["--data-dir", "other"], { FLINT_DATA_DIR: abs }).out).toBe(abs);
  });

  it("without either, nothing is set", () => {
    expect(run([], {}).out).toBe("");
  });
});
