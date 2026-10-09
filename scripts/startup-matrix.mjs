// Runs the start-in-hostile-conditions matrix and prints one JSON line per
// scenario: exit code, wall time, last lines. Never touches the real ~/.flint:
// every scenario gets a fresh temp data dir and a temp HOME/USERPROFILE.
// Usage: node scripts/startup-matrix.mjs [filter]
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, openSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const TIMEOUT = 20000;
const FAKE_KEY = "sk-or-v1-0123456789abcdef0123456789abcdef";

function sandbox(name) {
  const base = mkdtempSync(join(tmpdir(), "flint-mx-"));
  const data = join(base, "data " + name);
  const home = join(base, "home");
  mkdirSync(data, { recursive: true });
  mkdirSync(home, { recursive: true });
  return { base, data, home };
}

function baseEnv(sb, extra = {}) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (/API_KEY|^FLINT_|^HTTPS?_PROXY|^OPENROUTER|^NODE_ENV/i.test(k)) delete env[k];
  }
  return {
    ...env,
    FLINT_DATA_DIR: sb.data,
    HOME: sb.home,
    USERPROFILE: sb.home,
    FLINT_UPDATE_CHECK: "0",
    ...extra,
  };
}

const NUL = process.platform === "win32" ? String.raw`\\.\NUL` : "/dev/null";
const scenarios = [];
function add(id, desc, { args = [], entry = "bin/flint.js", stdin = "ignore", setup, env = {}, } = {}) {
  scenarios.push({ id, desc, args, entry, stdin, setup, env });
}

for (const entry of ["bin/flint.js", "src/index.js"]) {
  for (const flag of ["--help", "--version"]) {
    for (const stdin of ["ignore", "empty-pipe", "devnull"]) {
      add(`1 ${entry} ${flag} stdin=${stdin}`, "help/version", { args: [flag], entry, stdin });
    }
  }
}
add("2 first run, no key, no net, stdin=empty-pipe", "wizard", { stdin: "empty-pipe", env: { HTTPS_PROXY: "http://127.0.0.1:9", HTTP_PROXY: "http://127.0.0.1:9" } });
add("2b first run, no key, stdin=devnull, src/index.js", "wizard", { stdin: "devnull", entry: "src/index.js" });
add("3 no network, fake key, headless", "no net", {
  args: ["--headless", "--task", "x"], env: { OPENROUTER_API_KEY: FAKE_KEY, HTTPS_PROXY: "http://127.0.0.1:9", HTTP_PROXY: "http://127.0.0.1:9" },
  setup: (sb) => (mkdirSync(join(sb.home, ".flint")), writeFileSync(join(sb.home, ".flint", "providers.json"), JSON.stringify({ openrouter: { name: "OpenRouter", baseUrl: "http://127.0.0.1:59998/v1", defaultModel: "x/y", keyRequired: true } }))),
});
add("3b --task x without --headless, fake key, no net, stdin=devnull", "task without headless", {
  args: ["--task", "x"], stdin: "devnull", env: { OPENROUTER_API_KEY: FAKE_KEY, HTTPS_PROXY: "http://127.0.0.1:9" },
});
add("4 no key at all, headless", "headless nokey", { args: ["--headless", "--task", "x"] });
add("4b no key at all, --check", "check nokey", { args: ["--check"] });
add("5a data dir empty, fake key, headless", "empty data", { args: ["--headless", "--task", "x"], env: { OPENROUTER_API_KEY: FAKE_KEY, HTTPS_PROXY: "http://127.0.0.1:9" } });
add("5b data dir read-only (path is a file), fake key, headless", "ro data", {
  args: ["--headless", "--task", "x"], env: { OPENROUTER_API_KEY: FAKE_KEY, HTTPS_PROXY: "http://127.0.0.1:9" },
  setup: (sb) => { const f = join(sb.base, "afile"); writeFileSync(f, "x"); return { dataDir: f }; },
});
add("5c data dir with spaces and Cyrillic, fake key, headless", "cyr data", {
  args: ["--headless", "--task", "x"], env: { OPENROUTER_API_KEY: FAKE_KEY, HTTPS_PROXY: "http://127.0.0.1:9" },
  setup: (sb) => { const d = join(sb.base, "папка с пробелами", "данные flint"); mkdirSync(d, { recursive: true }); return { dataDir: d }; },
});
const corrupt = (file, content = "{{{ not json \u0000\u0001") => (sb) => writeFileSync(join(sb.data, file), content);
add("6a corrupt provider.json, fake key, headless", "c", { args: ["--headless", "--task", "x"], env: { OPENROUTER_API_KEY: FAKE_KEY, HTTPS_PROXY: "http://127.0.0.1:9" }, setup: corrupt("provider.json") });
add("6b corrupt providers.json, fake key, headless", "c", { args: ["--headless", "--task", "x"], env: { OPENROUTER_API_KEY: FAKE_KEY, HTTPS_PROXY: "http://127.0.0.1:9" }, setup: (sb) => { mkdirSync(join(sb.home, ".flint")); writeFileSync(join(sb.home, ".flint", "providers.json"), "{{{ bad"); } });
add("6c corrupt keys.enc, no env key, headless", "c", { args: ["--headless", "--task", "x"], setup: corrupt("keys.enc", "garbage\u0000ÿ") });
add("6d corrupt keys.enc, fake key in env, headless", "c", { args: ["--headless", "--task", "x"], env: { OPENROUTER_API_KEY: FAKE_KEY, HTTPS_PROXY: "http://127.0.0.1:9" }, setup: corrupt("keys.enc", "garbage\u0000ÿ") });
add("6e corrupt config files (permissions/api-token/spend/intent), fake key, headless", "c", {
  args: ["--headless", "--task", "x"], env: { OPENROUTER_API_KEY: FAKE_KEY, HTTPS_PROXY: "http://127.0.0.1:9" },
  setup: (sb) => { for (const f of ["permissions.json", ".permissions.json", "api-token", "spend.json", "intent-decisions.json", "config.json", "onboarding.json", "settings.json"]) writeFileSync(join(sb.data, f), "{{{ bad"); },
});
add("6f corrupt sessions json, --last, fake key, stdin=devnull", "c", {
  args: ["--last"], stdin: "devnull", env: { OPENROUTER_API_KEY: FAKE_KEY, HTTPS_PROXY: "http://127.0.0.1:9" },
  setup: (sb) => { const d = join(sb.data, "sessions"); mkdirSync(d, { recursive: true }); writeFileSync(join(d, "bad.json"), "{{{ bad"); writeFileSync(join(d, "empty.json"), ""); },
});
add("6g corrupt sessions json, --list", "c", {
  args: ["--list"], stdin: "devnull",
  setup: (sb) => { const d = join(sb.data, "sessions"); mkdirSync(d, { recursive: true }); writeFileSync(join(d, "bad.json"), "{{{ bad"); writeFileSync(join(d, "empty.json"), ""); },
});
add("7a closed stdin interactive, fake key", "closed", { stdin: "ignore", env: { OPENROUTER_API_KEY: FAKE_KEY, HTTPS_PROXY: "http://127.0.0.1:9" } });
add("7b empty-pipe stdin interactive, fake key", "closed", { stdin: "empty-pipe", env: { OPENROUTER_API_KEY: FAKE_KEY, HTTPS_PROXY: "http://127.0.0.1:9" } });
add("7c devnull stdin interactive, fake key, src/index.js", "closed", { stdin: "devnull", entry: "src/index.js", env: { OPENROUTER_API_KEY: FAKE_KEY, HTTPS_PROXY: "http://127.0.0.1:9" } });
add("8a ollama selected, not running, headless", "ollama", { args: ["--headless", "--task", "x", "--provider", "ollama"] });
add("8b ollama selected, not running, interactive stdin=devnull", "ollama", { args: ["--provider", "ollama"], stdin: "devnull" });
add("8c ollama selected via provider.json, not running, headless", "ollama", {
  args: ["--headless", "--task", "x"], setup: (sb) => writeFileSync(join(sb.data, "provider.json"), JSON.stringify({ activeProvider: "ollama", lastModel: {} })),
});

function run(s) {
  return new Promise((done) => {
    const sb = sandbox(s.id.replace(/\W+/g, "_").slice(0, 20));
    let dataDir = sb.data;
    const r = s.setup ? s.setup(sb) : null;
    if (r?.dataDir) dataDir = r.dataDir;
    const env = baseEnv(sb, { ...s.env, FLINT_DATA_DIR: dataDir });
    const stdio = [s.stdin === "devnull" ? openSync(NUL, "r") : s.stdin === "ignore" ? "ignore" : "pipe", "pipe", "pipe"];
    const t0 = Date.now();
    const child = spawn(process.execPath, [join(ROOT, s.entry), ...s.args], { cwd: sb.base, env, stdio, windowsHide: true });
    if (s.stdin === "empty-pipe") child.stdin.end();
    let out = "", err = "", killed = false;
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => { killed = true; spawn("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore" }); child.kill("SIGKILL"); }, TIMEOUT);
    child.on("exit", (code, sig) => {
      clearTimeout(timer);
      const strip = (x) => x.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").split(/\r?\n/).filter(Boolean);
      done({ id: s.id, code, sig, timedOut: killed, sec: ((Date.now() - t0) / 1000).toFixed(1), out: strip(out).slice(-4), err: strip(err).slice(-4) });
    });
  });
}

const filter = process.argv[2];
const list = scenarios.filter((s) => !filter || s.id.includes(filter));
const results = [];
// Three at a time: each run is mostly waiting.
const queue = [...list];
await Promise.all([0].map(async () => {
  while (queue.length) { const s = queue.shift(); const r = await run(s); results.push(r); console.log(JSON.stringify(r)); }
}));
