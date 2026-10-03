import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMockStore } from "../../helpers/mock-store.js";

vi.mock("../../../src/ui/output.js", () => ({
  printProcessStart: vi.fn(),
  printProcessEnd: vi.fn(),
  printProcessSummary: vi.fn(),
  setProcessStream: vi.fn(),
}));

// Asserted through run_command only, so the test says what the model sees:
// the python and npm a shell command reaches are Flint's own, where it may
// install.
describe("run_command uses Flint's own environment", () => {
  let dir;
  let h;
  const saved = process.env.FLINT_ENV_DIR;
  const savedOff = process.env.FLINT_OWN_ENV;

  beforeAll(async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "flint-env-")));
    process.env.FLINT_ENV_DIR = dir;
    // The test configs turn the own env off for every other test.
    delete process.env.FLINT_OWN_ENV;
    const { createProcessHandlers } = await import("../../../src/tools/process-tools.js");
    h = createProcessHandlers(createMockStore());
  });

  afterAll(() => {
    if (saved === undefined) delete process.env.FLINT_ENV_DIR;
    else process.env.FLINT_ENV_DIR = saved;
    if (savedOff !== undefined) process.env.FLINT_OWN_ENV = savedOff;
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  const norm = (p) => p.trim().replace(/\\/g, "/").toLowerCase();

  it("python in a command is the own venv, so pip installs land where Flint may write", async () => {
    const out = await h.run_command({ command: "python -c \"import sys; print(sys.prefix)\"", timeout: 120 });
    expect(norm(out)).toBe(norm(join(dir, "py")));
  }, 180000);

  it("npm's global prefix is the own prefix", async () => {
    const out = await h.run_command({ command: "npm config get prefix", timeout: 60 });
    expect(norm(out)).toBe(norm(join(dir, "npm")));
  }, 90000);
});
