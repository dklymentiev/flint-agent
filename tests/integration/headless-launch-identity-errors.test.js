// A headless launch whose identity cannot be read ends with one sentence and
// exit code 2, the way the stdio mode ends on the same mistakes. Before: the
// instructions file and .mcp.json were read in bootstrap() with nothing around
// them, so a wrong --system-prompt-file path or a .mcp.json with a typo came
// out as an unhandled exception with "at async bootstrap (...)".
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// Spawned like tests/integration/start-damaged-state.test.js: a temp HOME and
// data dir, no real key, the process started in the temp folder.
function start(args, prepare = () => {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "flint-hd-id-err-"));
  const data = path.join(home, "data");
  fs.mkdirSync(data, { recursive: true });
  prepare(home);
  const env = { ...process.env, HOME: home, USERPROFILE: home, FLINT_DATA_DIR: data, FLINT_UPDATE_CHECK: "0", FLINT_OWN_ENV: "0", MCP_SERVERS: "" };
  for (const k of Object.keys(env)) if (/API_KEY/i.test(k)) delete env[k];
  env.OPENROUTER_API_KEY = "sk-or-v1-0123456789abcdef0123456789abcdef";
  try {
    return spawnSync(process.execPath, [path.join(ROOT, "src/index.js"), "--headless", "--task", "x", ...args], {
      encoding: "utf8", timeout: 40000, cwd: home, env, input: "", killSignal: "SIGKILL",
    });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function expectOneClearLine(r, pattern) {
  expect(r.error, "it hung and was killed").toBeUndefined();
  expect(r.status).toBe(2);
  expect(r.stderr).not.toMatch(/\n\s+at \S+ \(?(file:|node:)/);
  expect(r.stderr).not.toMatch(/SyntaxError|Unhandled|uncaught/i);
  // "[key source] ..." is the note every headless start prints about where its
  // key came from (index.js, before bootstrap); it is not about this failure.
  const lines = r.stderr.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith("[key source]"));
  expect(lines, r.stderr).toHaveLength(1);
  expect(lines[0]).toMatch(/^\[flint\] /);
  expect(lines[0]).toMatch(pattern);
  // Nothing was run, so nothing is reported as a result.
  expect(r.stdout.trim()).toBe("");
}

describe("headless launch identity that cannot be read", () => {
  it("a missing --system-prompt-file ends with one line and exit code 2", () => {
    const r = start(["--system-prompt-file", "no-such-instructions.md"]);
    expectOneClearLine(r, /no-such-instructions\.md/);
  }, 60000);

  it("a missing --append-system-prompt-file ends the same way", () => {
    const r = start(["--append-system-prompt-file", "no-such-rules.md"]);
    expectOneClearLine(r, /no-such-rules\.md/);
  }, 60000);

  it("a malformed .mcp.json ends with one line that names the file, and exit code 2", () => {
    const r = start([], (home) => fs.writeFileSync(path.join(home, ".mcp.json"), '{ "mcpServers": { "a": '));
    expectOneClearLine(r, /\.mcp\.json.*not valid JSON/);
  }, 60000);
});
