import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { handlers as fsHandlers, clearDeniedPaths } from "../../src/tools/filesystem.js";

// Mock config so run_command resolves a valid projectRoot.
//
// `shell` has to be the same absolute path the product picks, not the bare word
// "bash". A bare name is resolved through PATH by spawn, and on Windows that
// finds C:\Windows\system32\bash.exe, which is WSL. The product deliberately
// avoids this (see the candidate list in config.js: Git Bash first, "bash" only
// as a last resort), so the bare name made this suite test a shell Flint never
// uses. On a Windows machine WSL then died translating a Cyrillic directory
// on PATH and all six shell cases failed for a reason that had nothing to do
// with the code under test.
const resolvedShell = vi.hoisted(() => {
  const nodeFs = require("node:fs");
  if (process.platform !== "win32") return "/bin/bash";
  const candidates = [
    process.env.ProgramFiles && `${process.env.ProgramFiles}\\Git\\usr\\bin\\bash.exe`,
    "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
  ].filter(Boolean);
  for (const p of candidates) {
    try { nodeFs.statSync(p); return p; } catch {}
  }
  return "bash";
});

vi.mock("../../src/config.js", () => ({
  config: {
    projectRoot: os.tmpdir(),
    apiKey: "test-key",
    model: "test-model",
    apiUrl: "https://test.api/v1/chat/completions",
    shell: resolvedShell,
  },
}));

// Mock UI output to suppress prints
vi.mock("../../src/ui/output.js", () => ({
  printChildAgent: () => {},
  printChildSpawn: () => {},
  printChildEvent: () => {},
  printProcessStart: () => {},
  printProcessEnd: () => {},
  printProcessSummary: () => {},
  setProcessStream: () => {},
}));

// Mock logger
vi.mock("../../src/logging/logger.js", () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

// ── Helpers ──

function createTmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flint-e2e-creative-"));
  return {
    path: dir,
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

let tmp;
let runCommand;

beforeEach(async () => {
  tmp = createTmpDir();
  clearDeniedPaths();
  // Lazy-import system tools after mocks are in place
  const { createSystemTools } = await import("../../src/tools/system.js");
  // Minimal mock store for createSystemTools
  const mockStore = {
    getState: () => ({
      startProcess: () => {},
      finishProcess: () => {},
      addProcessOutput: () => {},
      registerTask: () => "task-1",
      unregisterTask: () => {},
    }),
  };
  const { handlers: sysHandlers } = createSystemTools(mockStore);
  runCommand = sysHandlers.run_command;
});

afterEach(() => {
  tmp.cleanup();
});

// ═══════════════════════════════════════════════════════════════
// 1. Portfolio website
// ═══════════════════════════════════════════════════════════════

describe("Portfolio website", () => {
  it("creates index.html with name, bio, and links", async () => {
    const fp = path.join(tmp.path, "portfolio", "index.html");
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Jane Doe - Portfolio</title>
  <style>
    body { font-family: sans-serif; max-width: 800px; margin: 0 auto; padding: 2rem; }
    .bio { color: #555; line-height: 1.6; }
    .links a { display: inline-block; margin: 0.5rem 1rem 0.5rem 0; color: #07c; }
  </style>
</head>
<body>
  <h1 class="name">Jane Doe</h1>
  <p class="bio">Full-stack developer passionate about open source and creative coding.</p>
  <nav class="links">
    <a href="https://github.com/janedoe">GitHub</a>
    <a href="https://linkedin.com/in/janedoe">LinkedIn</a>
    <a href="mailto:jane@example.com">Email</a>
  </nav>
</body>
</html>`;

    const result = await fsHandlers.write_file({ path: fp, content: html });
    expect(result).toContain("File written");
    expect(fs.existsSync(fp)).toBe(true);

    const content = fs.readFileSync(fp, "utf-8");
    expect(content).toContain("Jane Doe");
    expect(content).toContain("class=\"bio\"");
    expect(content).toContain("class=\"links\"");
  });

  it("portfolio file contains valid HTML structure", async () => {
    const fp = path.join(tmp.path, "portfolio2", "index.html");
    const html = `<!DOCTYPE html><html><head><title>Portfolio</title><style>body{background:#111;color:#eee;}</style></head><body><h1>Alex Dev</h1><p class="bio">Builder of things.</p><div class="links"><a href="#">GitHub</a><a href="#">Twitter</a></div></body></html>`;
    await fsHandlers.write_file({ path: fp, content: html });

    const content = fs.readFileSync(fp, "utf-8");
    expect(content).toContain("<!DOCTYPE html>");
    expect(content).toContain("<style>");
    expect(content).toContain("</html>");
    expect(content).toContain("Alex Dev");
  });
});

// ═══════════════════════════════════════════════════════════════
// 2. Chatbot webpage
// ═══════════════════════════════════════════════════════════════

describe("Chatbot webpage", () => {
  it("creates chatbot HTML with input and output elements, >500 bytes", async () => {
    const fp = path.join(tmp.path, "chatbot", "index.html");
    const html = `<!DOCTYPE html>
<html>
<head><title>Chatbot</title></head>
<body>
  <div id="chat-output" style="border:1px solid #ccc;height:300px;overflow-y:auto;padding:10px;"></div>
  <input id="chat-input" type="text" placeholder="Type a message..." style="width:80%;">
  <button id="send-btn" onclick="sendMessage()">Send</button>
  <script>
    const responses = {
      hello: "Hi there! How can I help you?",
      help: "I can answer questions about weather, time, and jokes.",
      joke: "Why do programmers prefer dark mode? Because light attracts bugs!",
      weather: "It is always sunny in the cloud.",
      time: "Time is relative, but right now it is coding o'clock."
    };
    function sendMessage() {
      const input = document.getElementById('chat-input');
      const output = document.getElementById('chat-output');
      const msg = input.value.trim().toLowerCase();
      if (!msg) return;
      output.innerHTML += '<div class="user-msg"><b>You:</b> ' + input.value + '</div>';
      const key = Object.keys(responses).find(k => msg.includes(k));
      const reply = key ? responses[key] : "I don't understand that. Try 'hello', 'help', 'joke', 'weather', or 'time'.";
      output.innerHTML += '<div class="bot-msg"><b>Bot:</b> ' + reply + '</div>';
      input.value = '';
    }
  </script>
</body>
</html>`;

    await fsHandlers.write_file({ path: fp, content: html });

    const stat = fs.statSync(fp);
    expect(stat.size).toBeGreaterThan(500);

    const content = fs.readFileSync(fp, "utf-8");
    expect(content).toContain("chat-input");
    expect(content).toContain("chat-output");
    expect(content).toContain("sendMessage");
  });

  it("chatbot contains keyword-based response logic", async () => {
    const fp = path.join(tmp.path, "chatbot2", "bot.html");
    const html = `<html><body><div id="output"></div><input id="input"><script>
const rules = { hi: "Hello!", bye: "Goodbye!", thanks: "You're welcome!" };
function respond(msg) {
  const k = Object.keys(rules).find(r => msg.includes(r));
  return k ? rules[k] : "Sorry, I don't know that.";
}
</script></body></html>`;
    await fsHandlers.write_file({ path: fp, content: html });
    const content = fs.readFileSync(fp, "utf-8");
    expect(content).toContain("rules");
    expect(content).toContain("respond");
    expect(content).toContain("id=\"output\"");
    expect(content).toContain("id=\"input\"");
  });
});

// ═══════════════════════════════════════════════════════════════
// 3. HTML gallery from files
// ═══════════════════════════════════════════════════════════════

describe("HTML gallery from files", () => {
  it("creates 5 dummy files and gallery referencing all of them", async () => {
    const dir = path.join(tmp.path, "gallery");
    fs.mkdirSync(dir, { recursive: true });

    const files = ["sunset.txt", "mountain.txt", "ocean.txt", "forest.txt", "city.txt"];
    for (const f of files) {
      await fsHandlers.write_file({
        path: path.join(dir, f),
        content: `Placeholder for ${f.replace(".txt", "")} image`,
      });
    }

    const galleryHtml = `<!DOCTYPE html>
<html>
<head><title>Photo Gallery</title>
<style>.gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:1rem;}</style>
</head>
<body>
<h1>My Gallery</h1>
<div class="gallery">
${files.map((f) => `  <div class="item"><a href="${f}">${f.replace(".txt", "")}</a></div>`).join("\n")}
</div>
</body>
</html>`;

    const indexPath = path.join(dir, "index.html");
    await fsHandlers.write_file({ path: indexPath, content: galleryHtml });

    const content = fs.readFileSync(indexPath, "utf-8");
    for (const f of files) {
      expect(content).toContain(f);
    }
    expect(content).toContain("gallery");
  });

  it("all 5 dummy files exist on disk", async () => {
    const dir = path.join(tmp.path, "gallery2");
    fs.mkdirSync(dir, { recursive: true });
    const names = ["alpha.txt", "beta.txt", "gamma.txt", "delta.txt", "epsilon.txt"];
    for (const n of names) {
      await fsHandlers.write_file({ path: path.join(dir, n), content: `data for ${n}` });
    }
    for (const n of names) {
      expect(fs.existsSync(path.join(dir, n))).toBe(true);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// 4. Sorting algorithm visualization
// ═══════════════════════════════════════════════════════════════

describe("Sorting algorithm visualization", () => {
  it("creates HTML with bubble, quick, and merge sort references", async () => {
    const fp = path.join(tmp.path, "sorting", "index.html");
    const html = `<!DOCTYPE html>
<html>
<head><title>Sorting Visualizer</title>
<style>
  canvas { border: 1px solid #333; }
  .controls button { margin: 5px; padding: 8px 16px; }
</style>
</head>
<body>
  <h1>Sorting Algorithm Visualization</h1>
  <div class="controls">
    <button onclick="runSort('bubble')">Bubble Sort</button>
    <button onclick="runSort('quick')">Quick Sort</button>
    <button onclick="runSort('merge')">Merge Sort</button>
  </div>
  <canvas id="canvas" width="800" height="400"></canvas>
  <script>
    let arr = Array.from({length: 50}, () => Math.random() * 400);
    const canvas = document.getElementById('canvas');
    const ctx = canvas.getContext('2d');

    function draw(a) {
      ctx.clearRect(0, 0, 800, 400);
      a.forEach((v, i) => { ctx.fillStyle = '#4CAF50'; ctx.fillRect(i * 16, 400 - v, 14, v); });
    }

    async function bubbleSort(a) {
      for (let i = 0; i < a.length; i++)
        for (let j = 0; j < a.length - i - 1; j++)
          if (a[j] > a[j+1]) { [a[j], a[j+1]] = [a[j+1], a[j]]; draw(a); await delay(10); }
    }

    async function quickSort(a, lo = 0, hi = a.length - 1) {
      if (lo >= hi) return;
      let pivot = a[hi], i = lo;
      for (let j = lo; j < hi; j++) if (a[j] < pivot) { [a[i], a[j]] = [a[j], a[i]]; i++; }
      [a[i], a[hi]] = [a[hi], a[i]];
      draw(a); await delay(10);
      await quickSort(a, lo, i - 1);
      await quickSort(a, i + 1, hi);
    }

    async function mergeSort(a, lo = 0, hi = a.length - 1) {
      if (lo >= hi) return;
      const mid = (lo + hi) >> 1;
      await mergeSort(a, lo, mid);
      await mergeSort(a, mid + 1, hi);
      const tmp = []; let i = lo, j = mid + 1;
      while (i <= mid && j <= hi) tmp.push(a[i] <= a[j] ? a[i++] : a[j++]);
      while (i <= mid) tmp.push(a[i++]);
      while (j <= hi) tmp.push(a[j++]);
      for (let k = 0; k < tmp.length; k++) a[lo + k] = tmp[k];
      draw(a); await delay(10);
    }

    function delay(ms) { return new Promise(r => setTimeout(r, ms)); }
    function runSort(type) {
      arr = Array.from({length: 50}, () => Math.random() * 400);
      if (type === 'bubble') bubbleSort([...arr]);
      else if (type === 'quick') quickSort([...arr]);
      else if (type === 'merge') mergeSort([...arr]);
    }
    draw(arr);
  </script>
</body>
</html>`;

    await fsHandlers.write_file({ path: fp, content: html });
    const content = fs.readFileSync(fp, "utf-8");
    expect(content).toContain("bubbleSort");
    expect(content).toContain("quickSort");
    expect(content).toContain("mergeSort");
    expect(content).toContain("Bubble Sort");
    expect(content).toContain("Quick Sort");
    expect(content).toContain("Merge Sort");
  });

  it("sorting page includes canvas and interactive controls", async () => {
    const fp = path.join(tmp.path, "sorting2", "vis.html");
    const html = `<!DOCTYPE html><html><body>
<select id="algo"><option value="bubble">Bubble</option><option value="quick">Quick</option><option value="merge">Merge</option></select>
<button id="run">Run</button>
<canvas id="vis" width="600" height="300"></canvas>
<script>
document.getElementById('run').onclick = () => {
  const algo = document.getElementById('algo').value;
  console.log('Running', algo);
};
</script></body></html>`;
    await fsHandlers.write_file({ path: fp, content: html });
    const content = fs.readFileSync(fp, "utf-8");
    expect(content).toContain("<canvas");
    expect(content).toContain("<select");
    expect(content).toContain("bubble");
    expect(content).toContain("quick");
    expect(content).toContain("merge");
  });
});

// ═══════════════════════════════════════════════════════════════
// 5. Matrix hacker screen
// ═══════════════════════════════════════════════════════════════

describe("Matrix hacker screen", () => {
  it("creates HTML with green-on-black CSS animation and keyframes", async () => {
    const fp = path.join(tmp.path, "matrix", "index.html");
    const html = `<!DOCTYPE html>
<html>
<head><title>Matrix Rain</title>
<style>
  body { margin: 0; overflow: hidden; background: #000; }
  canvas { display: block; }
  @keyframes flicker {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.8; }
  }
  @keyframes glow {
    from { text-shadow: 0 0 5px #0f0; }
    to { text-shadow: 0 0 20px #0f0, 0 0 40px #0f0; }
  }
  .overlay {
    position: absolute; top: 10px; left: 10px;
    color: #0f0; font-family: monospace;
    animation: flicker 2s infinite, glow 1s alternate infinite;
  }
</style>
</head>
<body>
  <div class="overlay">SYSTEM BREACH DETECTED</div>
  <canvas id="c"></canvas>
  <script>
    const c = document.getElementById('c');
    const ctx = c.getContext('2d');
    c.width = window.innerWidth;
    c.height = window.innerHeight;
    const cols = Math.floor(c.width / 20);
    const drops = Array(cols).fill(1);
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789@#$%^&*';

    function draw() {
      ctx.fillStyle = 'rgba(0, 0, 0, 0.05)';
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.fillStyle = '#0f0';
      ctx.font = '15px monospace';
      drops.forEach((y, i) => {
        const ch = chars[Math.floor(Math.random() * chars.length)];
        ctx.fillText(ch, i * 20, y * 20);
        if (y * 20 > c.height && Math.random() > 0.975) drops[i] = 0;
        drops[i]++;
      });
    }
    setInterval(draw, 50);
  </script>
</body>
</html>`;

    await fsHandlers.write_file({ path: fp, content: html });
    const content = fs.readFileSync(fp, "utf-8");
    expect(content).toContain("@keyframes flicker");
    expect(content).toContain("@keyframes glow");
    expect(content).toContain("animation:");
    expect(content).toContain("background: #000");
    expect(content).toContain("color: #0f0");
  });

  it("matrix canvas renders green characters", async () => {
    const fp = path.join(tmp.path, "matrix2", "rain.html");
    const html = `<html><body style="background:#000"><canvas id="m"></canvas><style>@keyframes drop{from{transform:translateY(-100%)}to{transform:translateY(100vh)}}</style><script>const c=document.getElementById('m');c.width=800;c.height=600;</script></body></html>`;
    await fsHandlers.write_file({ path: fp, content: html });
    const content = fs.readFileSync(fp, "utf-8");
    expect(content).toContain("@keyframes drop");
    expect(content).toContain("canvas");
    expect(content).toContain("background:#000");
  });
});

// ═══════════════════════════════════════════════════════════════
// 6. Family tree SVG
// ═══════════════════════════════════════════════════════════════

describe("Family tree SVG", () => {
  it("creates SVG with rect, text, and line elements for 3 generations", async () => {
    const fp = path.join(tmp.path, "family", "tree.svg");
    const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="600" height="500" viewBox="0 0 600 500">
  <style>
    rect { fill: #e3f2fd; stroke: #1565c0; stroke-width: 2; rx: 8; }
    text { font-family: sans-serif; font-size: 14px; text-anchor: middle; fill: #333; }
    line { stroke: #666; stroke-width: 2; }
  </style>

  <!-- Generation 1: Grandparents -->
  <rect x="200" y="20" width="120" height="40" />
  <text x="260" y="45">Grandpa Joe</text>
  <rect x="350" y="20" width="120" height="40" />
  <text x="410" y="45">Grandma Mary</text>

  <!-- Lines from grandparents to parents -->
  <line x1="260" y1="60" x2="260" y2="120" />
  <line x1="410" y1="60" x2="410" y2="120" />
  <line x1="260" y1="120" x2="335" y2="120" />

  <!-- Generation 2: Parents -->
  <rect x="150" y="130" width="120" height="40" />
  <text x="210" y="155">Dad Robert</text>
  <rect x="300" y="130" width="120" height="40" />
  <text x="360" y="155">Mom Linda</text>

  <!-- Lines from parents to children -->
  <line x1="210" y1="170" x2="210" y2="240" />
  <line x1="360" y1="170" x2="360" y2="240" />
  <line x1="210" y1="240" x2="360" y2="240" />

  <!-- Generation 3: Children -->
  <rect x="100" y="250" width="120" height="40" />
  <text x="160" y="275">Alice</text>
  <rect x="250" y="250" width="120" height="40" />
  <text x="310" y="275">Bob</text>
  <rect x="400" y="250" width="120" height="40" />
  <text x="460" y="275">Carol</text>
</svg>`;

    await fsHandlers.write_file({ path: fp, content: svg });
    const content = fs.readFileSync(fp, "utf-8");
    expect(content).toContain("<svg");
    expect(content).toContain("<rect");
    expect(content).toContain("<text");
    expect(content).toContain("<line");
    // 3 generations
    expect(content).toContain("Grandpa Joe");
    expect(content).toContain("Dad Robert");
    expect(content).toContain("Alice");
  });

  it("SVG has correct namespace and viewBox", async () => {
    const fp = path.join(tmp.path, "family2", "tree.svg");
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300"><rect x="10" y="10" width="100" height="30"/><text x="60" y="30">Elder</text><line x1="60" y1="40" x2="60" y2="80"/><rect x="10" y="80" width="100" height="30"/><text x="60" y="100">Parent</text><line x1="60" y1="110" x2="60" y2="150"/><rect x="10" y="150" width="100" height="30"/><text x="60" y="170">Child</text></svg>`;
    await fsHandlers.write_file({ path: fp, content: svg });
    const content = fs.readFileSync(fp, "utf-8");
    expect(content).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(content).toContain("viewBox");
    // Verify all 3 generations
    expect(content).toContain("Elder");
    expect(content).toContain("Parent");
    expect(content).toContain("Child");
  });
});

// ═══════════════════════════════════════════════════════════════
// 7. Meme generator
// ═══════════════════════════════════════════════════════════════

describe("Meme generator", () => {
  it("creates HTML with placeholder image and text overlay", async () => {
    const fp = path.join(tmp.path, "meme", "index.html");
    const html = `<!DOCTYPE html>
<html>
<head><title>Meme Generator</title>
<style>
  .meme-container {
    position: relative; display: inline-block; max-width: 500px;
  }
  .meme-container img {
    width: 100%; display: block;
  }
  .meme-text-top, .meme-text-bottom {
    position: absolute; width: 100%; text-align: center;
    font-family: Impact, sans-serif; font-size: 2rem; color: white;
    text-shadow: 2px 2px 0 #000, -2px -2px 0 #000, 2px -2px 0 #000, -2px 2px 0 #000;
    text-transform: uppercase;
  }
  .meme-text-top { top: 10px; }
  .meme-text-bottom { bottom: 10px; }
</style>
</head>
<body>
  <h1>Meme Generator</h1>
  <div class="meme-container">
    <img src="https://via.placeholder.com/500x400" alt="meme placeholder">
    <div class="meme-text-top">When the code compiles</div>
    <div class="meme-text-bottom">On the first try</div>
  </div>
  <div class="controls">
    <input id="top-text" placeholder="Top text">
    <input id="bottom-text" placeholder="Bottom text">
    <button onclick="updateMeme()">Update</button>
  </div>
  <script>
    function updateMeme() {
      document.querySelector('.meme-text-top').textContent = document.getElementById('top-text').value;
      document.querySelector('.meme-text-bottom').textContent = document.getElementById('bottom-text').value;
    }
  </script>
</body>
</html>`;

    await fsHandlers.write_file({ path: fp, content: html });
    const content = fs.readFileSync(fp, "utf-8");
    expect(content).toContain("meme-container");
    expect(content).toContain("meme-text-top");
    expect(content).toContain("meme-text-bottom");
    expect(content).toContain("<img");
    expect(content).toContain("placeholder");
  });

  it("meme has Impact font and text-shadow styling", async () => {
    const fp = path.join(tmp.path, "meme2", "meme.html");
    const html = `<html><body><div class="meme-container"><img src="placeholder.png" alt="meme"><div class="meme-text-top" style="position:absolute;top:0;font-family:Impact;text-shadow:2px 2px #000">TOP</div><div class="meme-text-bottom" style="position:absolute;bottom:0;font-family:Impact;text-shadow:2px 2px #000">BOTTOM</div></div></body></html>`;
    await fsHandlers.write_file({ path: fp, content: html });
    const content = fs.readFileSync(fp, "utf-8");
    expect(content).toContain("Impact");
    expect(content).toContain("text-shadow");
    expect(content).toContain("meme-text-top");
    expect(content).toContain("meme-text-bottom");
  });
});

// ═══════════════════════════════════════════════════════════════
// 8. QR code generation (Node.js ASCII)
// ═══════════════════════════════════════════════════════════════

describe("QR code generation", () => {
  it("generates ASCII QR-like pattern via node script", async () => {
    const scriptPath = path.join(tmp.path, "qr.js");
    const script = `
const size = 21;
const grid = Array.from({length: size}, () => Array(size).fill(0));
function setFinder(r, c) {
  for (let i = 0; i < 7; i++)
    for (let j = 0; j < 7; j++)
      grid[r+i][c+j] = (i===0||i===6||j===0||j===6||(i>=2&&i<=4&&j>=2&&j<=4)) ? 1 : 0;
}
setFinder(0, 0);
setFinder(0, 14);
setFinder(14, 0);
for (let i = 7; i < 14; i++)
  for (let j = 7; j < 14; j++)
    grid[i][j] = (i + j) % 2 === 0 ? 1 : 0;
const out = grid.map(row => row.map(c => c ? '##' : '  ').join('')).join('\\n');
console.log(out);
console.log('QR_COMPLETE');
`;
    fs.writeFileSync(scriptPath, script, "utf-8");

    const result = await runCommand({ command: "node qr.js", cwd: tmp.path });
    expect(result).toContain("##");
    expect(result).toContain("QR_COMPLETE");
  });

  it("QR output has consistent grid dimensions", async () => {
    const scriptPath = path.join(tmp.path, "qr2.js");
    const script = `
const s = 11;
const g = Array.from({length: s}, () => Array(s).fill(0));
for (let i = 0; i < s; i++)
  for (let j = 0; j < s; j++)
    g[i][j] = (i * j) % 3 === 0 ? 1 : 0;
const lines = g.map(r => r.map(c => c ? 'X' : '.').join(''));
lines.forEach(l => console.log(l));
console.log('ROWS=' + lines.length);
`;
    fs.writeFileSync(scriptPath, script, "utf-8");

    const result = await runCommand({ command: "node qr2.js", cwd: tmp.path });
    expect(result).toContain("ROWS=11");
    expect(result).toContain("X");
    expect(result).toContain(".");
  });
});

// ═══════════════════════════════════════════════════════════════
// 9. Mandelbrot set (ASCII)
// ═══════════════════════════════════════════════════════════════

describe("Mandelbrot set", () => {
  it("computes 20x10 ASCII mandelbrot via node script", async () => {
    const scriptPath = path.join(tmp.path, "mandelbrot.js");
    const script = `
const W = 20, H = 10, maxIter = 50;
const chars = ' .:-=+*#%@';
let out = '';
for (let y = 0; y < H; y++) {
  let line = '';
  for (let x = 0; x < W; x++) {
    let cr = -2.5 + x * (3.5 / W), ci = -1 + y * (2 / H);
    let zr = 0, zi = 0, iter = 0;
    while (zr * zr + zi * zi < 4 && iter < maxIter) {
      let t = zr * zr - zi * zi + cr;
      zi = 2 * zr * zi + ci;
      zr = t;
      iter++;
    }
    line += chars[Math.min(Math.floor(iter / maxIter * chars.length), chars.length - 1)];
  }
  out += line + '\\n';
}
console.log(out);
console.log('MANDELBROT_DONE');
`;
    fs.writeFileSync(scriptPath, script, "utf-8");

    const result = await runCommand({ command: "node mandelbrot.js", cwd: tmp.path });
    expect(result).toContain("MANDELBROT_DONE");
    // Should contain a mix of characters indicating the fractal pattern
    expect(result).toMatch(/[.:\-=+*#%@]/);
    // Should have multiple distinct characters (not all the same)
    const unique = new Set(result.replace(/[\n\r\s]/g, "").split(""));
    expect(unique.size).toBeGreaterThanOrEqual(3);
  });

  it("mandelbrot output has expected dimensions", async () => {
    const scriptPath = path.join(tmp.path, "mandelbrot2.js");
    const script = `
const W = 20, H = 10;
let lines = [];
for (let y = 0; y < H; y++) {
  let l = '';
  for (let x = 0; x < W; x++) {
    let cr = -2 + x * 3 / W, ci = -1 + y * 2 / H, zr = 0, zi = 0, i = 0;
    while (zr * zr + zi * zi < 4 && i < 30) {
      let t = zr * zr - zi * zi + cr;
      zi = 2 * zr * zi + ci;
      zr = t;
      i++;
    }
    l += i < 30 ? '*' : ' ';
  }
  lines.push(l);
}
lines.forEach(l => console.log(l));
console.log('LINES=' + lines.length + ' WIDTH=' + lines[0].length);
`;
    fs.writeFileSync(scriptPath, script, "utf-8");

    const result = await runCommand({ command: "node mandelbrot2.js", cwd: tmp.path });
    expect(result).toContain("LINES=10");
    expect(result).toContain("WIDTH=20");
  });
});

// ═══════════════════════════════════════════════════════════════
// 10. CSV to HTML table
// ═══════════════════════════════════════════════════════════════

describe("CSV to HTML table", () => {
  it("creates CSV and converts to HTML table via node script", async () => {
    const csvPath = path.join(tmp.path, "data.csv");
    const csv = `Name,Age,City
Alice,30,New York
Bob,25,San Francisco
Carol,35,Chicago
Dave,28,Boston`;

    await fsHandlers.write_file({ path: csvPath, content: csv });

    const scriptPath = path.join(tmp.path, "csv2html.js");
    const script = `
const fs = require('fs');
const path = require('path');
const data = fs.readFileSync(path.join(__dirname, 'data.csv'), 'utf-8').trim().split('\\n');
const headers = data[0].split(',');
const rows = data.slice(1).map(r => r.split(','));
let html = '<table border="1">\\n<thead><tr>';
headers.forEach(h => { html += '<th>' + h + '</th>'; });
html += '</tr></thead>\\n<tbody>';
rows.forEach(r => { html += '<tr>'; r.forEach(c => { html += '<td>' + c + '</td>'; }); html += '</tr>\\n'; });
html += '</tbody></table>';
console.log(html);
console.log('TABLE_DONE');
`;
    fs.writeFileSync(scriptPath, script, "utf-8");

    const result = await runCommand({ command: "node csv2html.js", cwd: tmp.path });
    expect(result).toContain("TABLE_DONE");
    expect(result).toContain("<table");
    expect(result).toContain("<th>Name</th>");
    expect(result).toContain("<th>Age</th>");
    expect(result).toContain("<th>City</th>");
    expect(result).toContain("<td>Alice</td>");
    expect(result).toContain("<td>San Francisco</td>");
  });

  it("CSV with different columns also converts correctly", async () => {
    const csvPath = path.join(tmp.path, "products.csv");
    const csv = `Product,Price,Stock
Widget,9.99,100
Gadget,24.99,50
Gizmo,14.99,75`;

    await fsHandlers.write_file({ path: csvPath, content: csv });

    const scriptPath = path.join(tmp.path, "csv2html2.js");
    const script = `
const fs = require('fs');
const path = require('path');
const lines = fs.readFileSync(path.join(__dirname, 'products.csv'), 'utf-8').trim().split('\\n');
const hdr = lines[0].split(',');
let html = '<table><tr>' + hdr.map(h => '<th>' + h + '</th>').join('') + '</tr>';
lines.slice(1).forEach(l => {
  const cols = l.split(',');
  html += '<tr>' + cols.map(c => '<td>' + c + '</td>').join('') + '</tr>';
});
html += '</table>';
console.log(html);
console.log('COLS=' + hdr.length);
`;
    fs.writeFileSync(scriptPath, script, "utf-8");

    const result = await runCommand({ command: "node csv2html2.js", cwd: tmp.path });
    expect(result).toContain("COLS=3");
    expect(result).toContain("<th>Product</th>");
    expect(result).toContain("<th>Price</th>");
    expect(result).toContain("<td>Widget</td>");
    expect(result).toContain("<td>24.99</td>");
  });
});
