// Where the install-relative state (sessions/, .permissions.json, knowledge/)
// goes when nobody set FLINT_DATA_DIR.
//
// A checkout or a per-user npm prefix can be written by the person who runs
// Flint, and state stays next to the install as it always has. A system
// install (root-owned /opt/..., /usr/lib/node_modules) cannot, and there the
// rule is ~/.flint: without it a plain `flint` on such a machine could not
// start at all.
//
// The one syscall that answers "can this user write the install" is faked;
// the real thing is covered by tests/integration/startup-refusals.test.js and
// by a run as another user against a root-owned copy.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const FAKE_HOME = path.resolve("/fake-home");

let installWritable = true;
const writes = [];

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, default: { ...actual, homedir: () => FAKE_HOME }, homedir: () => FAKE_HOME };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal();
  const fake = {
    ...actual,
    mkdirSync: () => undefined,
    unlinkSync: () => undefined,
    writeFileSync: (file) => {
      writes.push(String(file));
      if (!installWritable && String(file).startsWith(repoRoot)) {
        throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      }
    },
  };
  return { ...fake, default: fake };
});

describe("installStateDir", () => {
  let savedEnv;

  beforeEach(() => {
    savedEnv = process.env.FLINT_DATA_DIR;
    delete process.env.FLINT_DATA_DIR;
    writes.length = 0;
    vi.resetModules();
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.FLINT_DATA_DIR;
    else process.env.FLINT_DATA_DIR = savedEnv;
  });

  it("stays next to the install when the install can be written", async () => {
    installWritable = true;
    const { installStateDir } = await import("../../src/data-dir.js");
    expect(installStateDir()).toBe(repoRoot);
  });

  it("is ~/.flint when the install cannot be written", async () => {
    installWritable = false;
    const { installStateDir, homeStateDir } = await import("../../src/data-dir.js");
    expect(installStateDir()).toBe(path.join(FAKE_HOME, ".flint"));
    expect(installStateDir()).toBe(homeStateDir());
  });

  it("FLINT_DATA_DIR wins either way, and the install is not even asked", async () => {
    installWritable = false;
    process.env.FLINT_DATA_DIR = path.resolve("/chosen");
    const { installStateDir } = await import("../../src/data-dir.js");
    expect(installStateDir()).toBe(path.resolve("/chosen"));
    expect(writes).toEqual([]);
  });

  it("a child agent's sessions follow the install rule, not its own FLINT_DATA_DIR", async () => {
    // The parent starts a child with FLINT_DATA_DIR=~/.flint/children/<port>.
    installWritable = false;
    process.env.FLINT_DATA_DIR = path.join(FAKE_HOME, ".flint", "children", "3010");
    const { defaultInstallStateDir, installStateDir } = await import("../../src/data-dir.js");
    expect(installStateDir()).toBe(path.join(FAKE_HOME, ".flint", "children", "3010"));
    expect(defaultInstallStateDir()).toBe(path.join(FAKE_HOME, ".flint"));
  });

  it("asks the install once per process, not on every call", async () => {
    installWritable = true;
    const { installStateDir } = await import("../../src/data-dir.js");
    installStateDir();
    installStateDir();
    installStateDir();
    expect(writes.length).toBe(1);
  });
});
