// React's development build records a performance.measure per render and
// never clears them: 72,784 after the 2026-10-02 overnight soak, most of a
// 97 MB live heap. Started without NODE_ENV, Flint must load the production
// build (src/production-env.js), and hand NODE_ENV back unchanged.
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const url = (p) => pathToFileURL(path.join(ROOT, p)).href;

// Renders an Ink component 50 times and prints the measure count and NODE_ENV.
const script = (withFix) => `
${withFix ? `const { restoreNodeEnv } = await import(${JSON.stringify(url("src/production-env.js"))});` : ""}
const React = (await import("react")).default;
const { render, Text, Box } = await import("ink");
${withFix ? "restoreNodeEnv();" : ""}
const { EventEmitter } = await import("node:events");
const stdout = Object.assign(new EventEmitter(), { columns: 80, rows: 24, isTTY: true, write() { return true; } });
const h = React.createElement;
const inst = render(h(Box, null, h(Text, null, "frame 0")), { stdout, patchConsole: false });
for (let i = 1; i <= 50; i++) { inst.rerender(h(Box, null, h(Text, null, "frame " + i))); await new Promise((r) => setTimeout(r, 2)); }
inst.unmount();
console.log(JSON.stringify({ measures: performance.getEntriesByType("measure").length, nodeEnv: process.env.NODE_ENV ?? null }));
process.exit(0);
`;

function run(withFix, env) {
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", script(withFix)], {
    cwd: ROOT, env, encoding: "utf8", timeout: 60000,
  });
  return JSON.parse(out.trim().split("\n").pop());
}

describe("React build", () => {
  const { NODE_ENV, ...withoutNodeEnv } = process.env;

  it("the development build does pile up measures (what the fix is for)", () => {
    expect(run(false, { ...withoutNodeEnv, NODE_ENV: "development" }).measures).toBeGreaterThan(20);
  }, 60000);

  it("started without NODE_ENV, Flint renders with none, and NODE_ENV is unset again", () => {
    const r = run(true, withoutNodeEnv);
    expect(r.measures).toBe(0);
    expect(r.nodeEnv).toBeNull();
  }, 60000);

  it("an explicit NODE_ENV is left as it was", () => {
    expect(run(true, { ...withoutNodeEnv, NODE_ENV: "development" }).nodeEnv).toBe("development");
  }, 60000);
});
