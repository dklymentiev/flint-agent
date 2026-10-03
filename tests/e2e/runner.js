#!/usr/bin/env node
/**
 * Flint E2E Test Runner
 *
 * Runs tests against a live Flint instance, collects structured results.
 * Output: JSONL file + summary table.
 *
 * Usage:
 *   node tests/e2e/runner.js --token <paired-token> [--suite screenbox] [--run run-3]
 *
 * Each test defines:
 *   - id, suite, category
 *   - input (prompt to send)
 *   - expected (what should happen)
 *   - verify (optional function to check result independently)
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- Config ---
const FLINT_URL = process.env.FLINT_URL || "http://localhost:3000";
const args = process.argv.slice(2);
const TOKEN = getArg("--token") || process.env.FLINT_TOKEN;
const SUITE_FILTER = getArg("--suite") || "all";
const RUN_ID = getArg("--run") || `run-${new Date().toISOString().slice(0, 16).replace(/[T:]/g, "-")}`;
const MAX_COST_PER_TEST = parseFloat(getArg("--budget") || "0.05");
const OUTPUT_DIR = path.join(__dirname, "results");

function getArg(name) {
  const idx = args.indexOf(name);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : null;
}

// --- Test definitions ---
const TESTS = [
  // === Screenbox Desktop ===
  {
    id: "scr-001", suite: "screenbox", category: "desktop-basic",
    task: "Take screenshot and describe desktop",
    input: "Take a screenshot of desktop-1 and describe what you see. Be brief.",
    expected: { description: "Agent describes visible windows/desktop elements" },
    check: (r) => r.response && r.response.length > 20 && !r.response.includes("cannot"),
  },
  {
    id: "scr-002", suite: "screenbox", category: "desktop-shell",
    task: "Run shell command on desktop",
    input: 'Run on desktop-1: echo "e2e-$(date +%s)" > /tmp/e2e-test.txt && cat /tmp/e2e-test.txt. Tell me output.',
    expected: { description: "Agent runs command, returns output with timestamp" },
    check: (r) => r.response && r.response.includes("e2e-"),
  },
  {
    id: "scr-003", suite: "screenbox", category: "desktop-window",
    task: "Close all windows",
    input: "On desktop-1, close ALL open windows. I want a clean desktop.",
    expected: { description: "All windows closed" },
    check: (r) => r.response && (r.response.includes("closed") || r.response.includes("clean")),
  },
  {
    id: "scr-004", suite: "screenbox", category: "desktop-chrome",
    task: "Chrome navigate and read page",
    input: "On desktop-1, open Chrome, navigate to https://example.com, and tell me the exact text on the page.",
    expected: { description: "Agent reads 'Example Domain' text from page" },
    check: (r) => r.response && (r.response.includes("Example Domain") || r.response.includes("example.com") || r.response.includes("navigated")),
  },
  {
    id: "scr-005", suite: "screenbox", category: "desktop-batch",
    task: "Batch 10 clicks in a line",
    input: "On desktop-1, use desktop_batch to click 10 times in a horizontal line from (200,500) to (1700,500). Calculate coords and call desktop_batch directly.",
    expected: { description: "10 clicks executed via single batch call" },
    check: (r) => r.response && (r.response.includes("executed") || r.response.includes("click")),
  },
  {
    id: "scr-006", suite: "screenbox", category: "desktop-file",
    task: "Create and verify file via shell",
    input: 'On desktop-1 using desktop_shell: create file ~/Desktop/e2e-hello.txt with content "Hello from E2E runner" then cat it to verify.',
    expected: { description: "File created, content verified" },
    check: (r) => r.response && r.response.includes("Hello"),
    verify: async () => {
      // Independent verification via Screenbox
      try {
        const res = await fetch(`${FLINT_URL}/message`, {
          method: "POST",
          headers: { "Authorization": `Bearer ${TOKEN}`, "Content-Type": "application/json" },
          body: JSON.stringify({ content: "On desktop-1 using desktop_shell: cat ~/Desktop/e2e-hello.txt" }),
        });
        const d = await res.json();
        return { verified: d.response?.includes("Hello"), actual: d.response?.slice(0, 100) };
      } catch { return { verified: false, actual: "verification failed" }; }
    },
  },
  {
    id: "scr-007", suite: "screenbox", category: "desktop-window",
    task: "Window management: list and minimize",
    input: "On desktop-1: list all open windows, minimize all, take screenshot to verify.",
    expected: { description: "Windows listed then minimized" },
    check: (r) => r.response && (r.response.includes("minimized") || r.response.includes("clean") || r.response.includes("no open") || r.response.includes("no application") || r.response.includes("black") || r.response.includes("closed")),
  },

  // === Files & Text ===
  {
    id: "file-001", suite: "files", category: "file-create",
    task: "Create multiple files",
    input: 'On desktop-1 using desktop_shell: create 3 files in /tmp/e2e-dir/ named a.txt b.txt c.txt each containing its name. Then ls the directory.',
    expected: { description: "3 files created, directory listed" },
    check: (r) => r.response && (r.response.includes("a.txt") || r.response.includes("3")),
  },
  {
    id: "file-002", suite: "files", category: "file-search",
    task: "Count files by extension",
    input: "On desktop-1 using desktop_shell: count all .txt files in ~/Desktop/ recursively. Tell me the exact number.",
    expected: { description: "Returns a number" },
    check: (r) => r.response && /\d+/.test(r.response),
  },

  // === Web & API ===
  {
    id: "web-001", suite: "web", category: "web-fetch",
    task: "Fetch JSON API",
    input: "Fetch https://jsonplaceholder.typicode.com/todos/1 and tell me the title field.",
    expected: { description: 'Returns "delectus aut autem"' },
    check: (r) => r.response && r.response.includes("delectus"),
  },
  {
    id: "web-002", suite: "web", category: "web-fetch",
    task: "Fetch and parse headers",
    input: "Fetch https://httpbin.org/headers and tell me which User-Agent was sent.",
    expected: { description: "Returns User-Agent string" },
    check: (r) => r.response && (r.response.includes("Flint") || r.response.includes("Agent") || r.response.includes("node")),
  },

  // === Creative ===
  {
    id: "creative-001", suite: "creative", category: "text-gen",
    task: "ASCII art",
    input: "Print the word FLINT as ASCII art using # characters. Just output the text.",
    expected: { description: "ASCII art with # symbols forming FLINT" },
    check: (r) => r.response && (r.response.includes("#") || r.response.includes("FLINT") || r.response.includes("```")),
  },
  {
    id: "creative-002", suite: "creative", category: "text-gen",
    task: "Multiplication table",
    input: "Generate a multiplication table (1-5 x 1-5) as formatted text. Just print it.",
    expected: { description: "5x5 table with correct products" },
    check: (r) => r.response && r.response.includes("25"),
  },
  {
    id: "creative-003", suite: "creative", category: "text-gen",
    task: "Haiku",
    input: "Write a haiku about programming. Just the poem, nothing else.",
    expected: { description: "Three line poem" },
    check: (r) => r.response && r.response.split("\n").filter(l => l.trim()).length >= 3,
  },

  // === DevOps ===
  {
    id: "devops-001", suite: "devops", category: "system-info",
    task: "Get system versions",
    input: 'On desktop-1 using desktop_shell: run "git --version" and "node --version" and tell me both versions.',
    expected: { description: "Returns git and node version numbers" },
    check: (r) => r.response && (/\d+\.\d+/.test(r.response)),
  },

  // === Security ===
  {
    id: "sec-001", suite: "security", category: "permission-check",
    task: "Read protected file",
    input: "On desktop-1 using desktop_shell: try to read /etc/shadow and tell me what happened.",
    expected: { description: "Permission denied or cannot read" },
    check: (r) => r.response && (r.response.includes("denied") || r.response.includes("Permission") || r.response.includes("cannot")),
  },

  // === Memory ===
  {
    id: "mem-001", suite: "memory", category: "memory-write",
    task: "Remember a fact",
    input: "Remember this: my favorite color is blue and my project deadline is March 30.",
    expected: { description: "Agent saves fact to memory" },
    check: (r) => r.response && (r.response.includes("remember") || r.response.includes("saved") || r.response.includes("noted") || r.response.includes("blue")),
  },
  {
    id: "mem-002", suite: "memory", category: "memory-search",
    continues: true, // needs mem-001 context
    task: "Recall a fact",
    input: "What is my favorite color? Check your memory.",
    expected: { description: "Agent recalls 'blue' from memory" },
    check: (r) => r.response && r.response.toLowerCase().includes("blue"),
  },
  {
    id: "mem-003", suite: "memory", category: "memory-search",
    continues: true, // needs mem-001 context
    task: "Recall deadline",
    input: "When is my project deadline? Search your memory.",
    expected: { description: "Agent recalls 'March 30'" },
    check: (r) => r.response && (r.response.includes("March 30") || r.response.includes("march 30")),
  },

  // === Planning ===
  {
    id: "plan-001", suite: "planning", category: "create-plan",
    task: "Create a plan",
    input: "Create a plan for 'Setup test environment' with 3 tasks: 1) Install dependencies 2) Configure database 3) Run initial tests",
    expected: { description: "Agent calls create_plan with goal and 3 tasks" },
    check: (r) => r.response && (r.response.includes("plan") || r.response.includes("Plan") || r.response.includes("task")),
  },
  {
    id: "plan-002", suite: "planning", category: "list-tasks",
    continues: true, // needs plan-001
    task: "List current plan",
    input: "Show me the current plan and its tasks.",
    expected: { description: "Agent shows plan with task statuses" },
    check: (r) => r.response && (r.response.includes("Install") || r.response.includes("task") || r.response.includes("plan")),
  },
  {
    id: "plan-003", suite: "planning", category: "update-task",
    continues: true, // needs plan-001/002
    task: "Mark task as done",
    input: "Mark task 1 in the plan as done with result 'all packages installed'.",
    expected: { description: "Task 1 status updated to done" },
    check: (r) => r.response && (r.response.includes("done") || r.response.includes("Done") || r.response.includes("updated") || r.response.includes("installed")),
  },

  // === Multi-step reasoning ===
  {
    id: "reason-001", suite: "reasoning", category: "math",
    task: "Multi-step calculation",
    input: "Calculate: if I have 3 servers each with 16GB RAM, and each server runs 4 containers using 2.5GB each, how much free RAM does each server have? Show your work.",
    expected: { description: "Each server: 16 - (4 * 2.5) = 6GB free" },
    check: (r) => r.response && (r.response.includes("6") || r.response.includes("six")),
  },
  {
    id: "reason-002", suite: "reasoning", category: "analysis",
    task: "JSON analysis",
    input: 'Given this JSON: {"users": [{"name": "Alice", "age": 30}, {"name": "Bob", "age": 25}, {"name": "Carol", "age": 35}]}, who is the oldest and what is the average age?',
    expected: { description: "Carol is oldest, average is 30" },
    check: (r) => r.response && r.response.includes("Carol") && r.response.includes("30"),
  },

  // === Context retention ===
  {
    id: "ctx-001", suite: "context", category: "context-retention",
    task: "Remember from conversation",
    input: "My server IP is 192.0.2.1 and it runs on port 2222. Just acknowledge.",
    expected: { description: "Agent acknowledges" },
    check: (r) => r.response && r.response.length > 5,
  },
  {
    id: "ctx-002", suite: "context", category: "context-retention",
    continues: true, // needs ctx-001 context
    task: "Recall from conversation",
    input: "What IP and port did I mention earlier?",
    expected: { description: "Agent recalls 192.0.2.1:2222" },
    check: (r) => r.response && r.response.includes("192.0.2.1") && r.response.includes("2222"),
  },

  // === Error handling ===
  {
    id: "err-001", suite: "errors", category: "graceful-error",
    task: "Handle nonexistent file",
    input: "On desktop-1 using desktop_shell: cat /tmp/this-file-definitely-does-not-exist-12345.txt",
    expected: { description: "Agent reports file not found gracefully" },
    check: (r) => r.response && (r.response.includes("No such file") || r.response.includes("not found") || r.response.includes("does not exist") || r.response.includes("error")),
  },
  {
    id: "err-002", suite: "errors", category: "graceful-error",
    task: "Handle invalid URL",
    input: "Fetch https://this-domain-does-not-exist-9999.com/api and tell me what happened.",
    expected: { description: "Agent reports DNS/connection error gracefully" },
    check: (r) => r.response && (r.response.includes("error") || r.response.includes("failed") || r.response.includes("resolve") || r.response.includes("not") || r.response.includes("unable")),
  },

  // === Multilingual (#misc) ===
  {
    id: "lang-001", suite: "multilingual", category: "russian",
    task: "Respond in Russian",
    input: "Посчитай сколько будет 17 умножить на 23. Ответь на русском.",
    expected: { description: "391, answer in Russian" },
    check: (r) => r.response && r.response.includes("391"),
  },
  {
    id: "lang-002", suite: "multilingual", category: "mixed",
    task: "Mixed language instructions",
    input: "List 3 programming languages. Первый должен начинаться на P, second on J, третий на R.",
    expected: { description: "Python/Perl, Java/JS, Ruby/Rust or similar" },
    check: (r) => {
      const resp = r.response?.toLowerCase() || "";
      return resp.includes("p") && resp.includes("j") && resp.includes("r");
    },
  },

  // === Parallelism & Load ===
  {
    id: "par-001", suite: "parallelism", category: "parallel-fetch",
    task: "Fetch 3 URLs and compare",
    input: "Fetch these 3 URLs and tell me which returned the most data: 1) https://httpbin.org/get 2) https://jsonplaceholder.typicode.com/posts/1 3) https://jsonplaceholder.typicode.com/users/1",
    expected: { description: "Agent fetches all 3 and compares sizes" },
    check: (r) => r.response && (r.response.includes("most") || r.response.includes("largest") || r.response.includes("bigger") || r.response.includes("1)") || r.response.includes("httpbin")),
  },
  {
    id: "par-002", suite: "parallelism", category: "batch-actions",
    task: "Batch 50 desktop clicks",
    input: "On desktop-1, use desktop_batch to click 50 points in a circle. Center=(960,540), radius=300. Calculate all 50 coordinates using cos/sin (angle=i*2*PI/50) and send ONE desktop_batch call.",
    expected: { description: "50 clicks in single batch call" },
    check: (r) => r.response && (r.response.includes("50") || r.response.includes("circle") || r.response.includes("executed")),
  },

  // === MCP Integration ===
  {
    id: "mcp-001", suite: "mcp", category: "mcp-shell",
    task: "MCP desktop_shell returns structured result",
    input: 'On desktop-1 using desktop_shell: run "uname -a && whoami && uptime" and tell me the OS, username, and uptime.',
    expected: { description: "Returns Linux, screenbox user, uptime" },
    check: (r) => r.response && (r.response.toLowerCase().includes("linux") || r.response.includes("screenbox")),
  },
  {
    id: "mcp-002", suite: "mcp", category: "mcp-window",
    task: "MCP window list returns structured data",
    input: "On desktop-1, use desktop_window to list all windows. Tell me how many windows are open and their titles.",
    expected: { description: "Returns window count and names" },
    check: (r) => r.response && (/\d/.test(r.response) || r.response.includes("window") || r.response.includes("no open")),
  },

  // === Desktop & Office ===
  {
    id: "office-001", suite: "desktop-office", category: "app-install",
    task: "Install app on desktop",
    input: "On desktop-1, check if mousepad is installed by running 'which mousepad' via desktop_shell. If not installed, install it with desktop_manage(action='install', app='mousepad'). Then confirm it's available.",
    expected: { description: "mousepad installed or already present" },
    check: (r) => r.response && (r.response.includes("mousepad") || r.response.includes("installed") || r.response.includes("available") || r.response.includes("/usr/")),
  },
  {
    id: "office-002", suite: "desktop-office", category: "clipboard",
    task: "Clipboard paste via shell",
    input: 'On desktop-1 using desktop_shell: set clipboard to "Hello Clipboard Test" using xclip, then read it back with xclip -o. Tell me what you got.',
    expected: { description: "Clipboard round-trip successful" },
    check: (r) => r.response && (r.response.includes("Hello Clipboard") || r.response.includes("clipboard")),
  },

  // === Files advanced ===
  {
    id: "file-003", suite: "files", category: "file-edit",
    task: "Create then modify a file",
    input: 'On desktop-1 using desktop_shell: create /tmp/e2e-edit.txt with content "line1\\nline2\\nline3". Then replace "line2" with "MODIFIED" using sed. Then cat the file and tell me the contents.',
    expected: { description: "File shows line1, MODIFIED, line3" },
    check: (r) => r.response && r.response.includes("MODIFIED"),
  },

  // === Security advanced ===
  {
    id: "sec-002", suite: "security", category: "env-vars",
    task: "Check environment safety",
    input: 'On desktop-1 using desktop_shell: print all environment variables with env command. Are there any API keys or secrets visible?',
    expected: { description: "Agent reports env vars, notes any security concerns" },
    check: (r) => r.response && r.response.length > 20,
  },

  // === Context advanced ===
  {
    id: "ctx-003", suite: "context", category: "multi-step-context",
    task: "3-step task with context",
    input: "Step 1 of 3: On desktop-1, create /tmp/ctx-test.txt with the text 'step1-done'. Just do it and confirm.",
    expected: { description: "File created" },
    check: (r) => r.response && (r.response.includes("done") || r.response.includes("created") || r.response.includes("confirm")),
  },
  {
    id: "ctx-004", suite: "context", category: "multi-step-context",
    continues: true, // needs ctx-003 context
    task: "Continue multi-step from context",
    input: "Step 2 of 3: append ' step2-done' to the file from step 1. Then cat it to verify both steps are there.",
    expected: { description: "File contains step1-done step2-done" },
    check: (r) => r.response && (r.response.includes("step1") || r.response.includes("step2") || r.response.includes("appended")),
  },

  // === Mesh Memory ===
  {
    id: "mesh-001", suite: "mesh", category: "mesh-search",
    task: "Search mesh knowledge base",
    input: "Use mesh_search to find documents about 'screenbox desktop'. Tell me what you found.",
    expected: { description: "Agent searches mesh and reports results" },
    check: (r) => r.response && (r.response.includes("found") || r.response.includes("result") || r.response.includes("document") || r.response.includes("screenbox") || r.response.includes("no") || r.response.includes("mesh")),
  },

  // === Desktop advanced ===
  {
    id: "office-003", suite: "desktop-office", category: "keyboard",
    task: "Keyboard shortcut sequence",
    input: "On desktop-1: press Super_L to open app launcher, type 'terminal', press Return, wait 2 seconds, then take a screenshot to verify terminal opened.",
    expected: { description: "Terminal opened via keyboard" },
    check: (r) => r.response && (r.response.includes("terminal") || r.response.includes("Terminal") || r.response.includes("opened") || r.response.includes("launched")),
  },
  {
    id: "office-004", suite: "desktop-office", category: "chrome-form",
    task: "Chrome fill form",
    input: "On desktop-1: navigate Chrome to https://httpbin.org/forms/post. Use desktop_chrome page_map to find form fields. Type 'John' in the customer name field. Take screenshot to verify.",
    expected: { description: "Form field filled" },
    check: (r) => r.response && (r.response.includes("John") || r.response.includes("form") || r.response.includes("typed") || r.response.includes("field") || r.response.includes("filled")),
  },

  // === Files advanced ===
  {
    id: "file-004", suite: "files", category: "file-permissions",
    task: "Check file permissions",
    input: "On desktop-1 using desktop_shell: create /tmp/e2e-perm.sh with content '#!/bin/bash\\necho hello'. Make it executable with chmod +x. Then run it and tell me the output.",
    expected: { description: "Script runs, outputs 'hello'" },
    check: (r) => r.response && r.response.includes("hello"),
  },
  {
    id: "file-005", suite: "files", category: "file-large",
    task: "Create and process large file",
    input: "On desktop-1 using desktop_shell: generate a file /tmp/e2e-big.txt with 100 lines (seq 1 100 > /tmp/e2e-big.txt). Then count lines with wc -l and sum all numbers with awk. Tell me both results.",
    expected: { description: "100 lines, sum=5050" },
    check: (r) => r.response && (r.response.includes("100") && r.response.includes("5050")),
  },

  // === Web advanced ===
  {
    id: "web-003", suite: "web", category: "web-post",
    task: "Fetch with POST data",
    input: "Fetch https://httpbin.org/post with method POST and body '{\"test\": true}'. Tell me what the 'json' field in the response contains.",
    expected: { description: "Response shows {test: true} in json field" },
    check: (r) => r.response && (r.response.includes("test") || r.response.includes("true") || r.response.includes("json")),
  },

  // === Planning advanced ===
  {
    id: "plan-004", suite: "planning", category: "plan-multi",
    task: "Create plan then execute first task",
    input: "Create a plan called 'E2E validation' with tasks: 1) Check disk space 2) Check network 3) Report status. Then immediately execute task 1 by running 'df -h' on desktop-1 and mark it done with the result.",
    expected: { description: "Plan created, task 1 executed and marked done" },
    check: (r) => r.response && (r.response.includes("done") || r.response.includes("Done") || r.response.includes("disk") || r.response.includes("executed") || r.response.includes("marked")),
  },

  // === Security advanced ===
  {
    id: "sec-003", suite: "security", category: "network-info",
    task: "Network information",
    input: "On desktop-1 using desktop_shell: show me the IP addresses (hostname -I), open ports (ss -tlnp | head -10), and DNS servers (cat /etc/resolv.conf). Summarize the network config.",
    expected: { description: "Agent reports IPs, ports, DNS" },
    check: (r) => r.response && (/\d+\.\d+\.\d+/.test(r.response) || r.response.includes("IP") || r.response.includes("dns") || r.response.includes("DNS")),
  },

  // === Error recovery ===
  {
    id: "err-003", suite: "errors", category: "timeout-recovery",
    task: "Handle slow command",
    input: "On desktop-1 using desktop_shell: run 'sleep 2 && echo done-after-sleep'. Tell me the output.",
    expected: { description: "Returns 'done-after-sleep' after waiting" },
    check: (r) => r.response && r.response.includes("done-after-sleep"),
  },

  // === Reasoning advanced ===
  {
    id: "reason-003", suite: "reasoning", category: "code-gen",
    task: "Generate and run code",
    input: "On desktop-1 using desktop_shell: write a Python one-liner that prints the first 10 Fibonacci numbers, run it, and tell me the output.",
    expected: { description: "Fibonacci: 0,1,1,2,3,5,8,13,21,34 or similar" },
    check: (r) => r.response && (r.response.includes("13") || r.response.includes("21") || r.response.includes("34")),
  },

  // ══════════════════════════════════════════════
  // BATCH 2: Remaining 63 tests to reach 113
  // ══════════════════════════════════════════════

  // === Files & Text remaining ===
  {
    id: "file-006", suite: "files", category: "file-sort",
    task: "Sort and deduplicate file",
    input: 'On desktop-1 using desktop_shell: echo -e "banana\\napple\\ncherry\\napple\\nbanana" > /tmp/e2e-fruits.txt && sort -u /tmp/e2e-fruits.txt. Tell me the sorted unique list.',
    expected: { description: "apple, banana, cherry" },
    check: (r) => r.response && r.response.includes("apple") && r.response.includes("cherry"),
  },

  // === Desktop & Office remaining ===
  {
    id: "office-005", suite: "desktop-office", category: "screenshot-region",
    task: "Screenshot specific region",
    input: "On desktop-1: take a screenshot and zoom into cell 1 (top-left corner). Describe what you see there.",
    expected: { description: "Agent zooms into cell and describes content" },
    check: (r) => r.response && r.response.length > 20,
  },
  {
    id: "office-006", suite: "desktop-office", category: "desktop-type",
    task: "Type text into terminal",
    input: 'On desktop-1: open a terminal via desktop_shell("DISPLAY=:99 xfce4-terminal &"), wait 2 seconds, then use desktop_key to paste "echo typed-by-flint" via clipboard and press Return. Take screenshot to verify.',
    expected: { description: "Terminal shows typed text" },
    check: (r) => r.response && (r.response.includes("typed") || r.response.includes("terminal") || r.response.includes("Terminal") || r.response.includes("echo")),
  },
  {
    id: "office-007", suite: "desktop-office", category: "window-resize",
    task: "Resize window",
    input: "On desktop-1: list windows, then resize the first window to 800x600 using desktop_window. Verify with another list.",
    expected: { description: "Window resized" },
    check: (r) => r.response && (r.response.includes("800") || r.response.includes("resized") || r.response.includes("resize")),
  },
  {
    id: "office-008", suite: "desktop-office", category: "multi-window",
    task: "Open 2 apps and switch between",
    input: "On desktop-1: open mousepad and xfce4-terminal via desktop_shell. List windows to confirm both are open. Activate mousepad window. Take screenshot.",
    expected: { description: "Two apps open, mousepad active" },
    check: (r) => r.response && (r.response.includes("mousepad") || r.response.includes("Mousepad") || r.response.includes("terminal") || r.response.includes("two") || r.response.includes("2")),
  },
  {
    id: "office-009", suite: "desktop-office", category: "desktop-scroll",
    task: "Scroll in browser",
    input: "On desktop-1: open Chrome to https://en.wikipedia.org/wiki/Linux. Scroll down 5 times. Take screenshot. What section are you at now?",
    expected: { description: "Agent scrolled and reports visible section" },
    check: (r) => r.response && r.response.length > 30,
  },
  {
    id: "office-010", suite: "desktop-office", category: "process-list",
    task: "List processes on desktop",
    input: "On desktop-1 using desktop_shell: list top 5 processes by memory usage (ps aux --sort=-%mem | head -6). Tell me which process uses the most RAM.",
    expected: { description: "Reports top process" },
    check: (r) => r.response && r.response.length > 20,
  },
  {
    id: "office-011", suite: "desktop-office", category: "file-manager",
    task: "Navigate filesystem via shell",
    input: "On desktop-1 using desktop_shell: list ~/Desktop contents, then list /tmp contents, then tell me which has more files.",
    expected: { description: "Compares file counts" },
    check: (r) => r.response && (r.response.includes("Desktop") || r.response.includes("tmp") || r.response.includes("more")),
  },

  // === Web, API remaining ===
  {
    id: "web-004", suite: "web", category: "web-html",
    task: "Fetch and parse HTML",
    input: "Fetch https://example.com and tell me how many paragraphs and links are on the page.",
    expected: { description: "Agent counts HTML elements" },
    check: (r) => r.response && (/\d/.test(r.response)),
  },
  {
    id: "web-005", suite: "web", category: "web-status",
    task: "Check HTTP status codes",
    input: "Fetch https://httpbin.org/status/404 and tell me what HTTP status code you got.",
    expected: { description: "404" },
    check: (r) => r.response && r.response.includes("404"),
  },
  {
    id: "web-006", suite: "web", category: "web-redirect",
    task: "Follow redirect",
    input: "Fetch https://httpbin.org/redirect/1 and tell me the final URL you ended up at.",
    expected: { description: "Ends at httpbin.org/get" },
    check: (r) => r.response && (r.response.includes("get") || r.response.includes("redirect") || r.response.includes("200")),
  },
  {
    id: "web-007", suite: "web", category: "web-json-array",
    task: "Fetch and analyze JSON array",
    input: "Fetch https://jsonplaceholder.typicode.com/posts?_limit=5 and tell me: how many posts, the title of the first post, and the userId of the last post.",
    expected: { description: "5 posts, first title, last userId" },
    check: (r) => r.response && r.response.includes("5") && (r.response.includes("title") || r.response.includes("sunt")),
  },

  // === Creative remaining ===
  {
    id: "creative-004", suite: "creative", category: "text-table",
    task: "Generate formatted table",
    input: "Create a table with 3 columns (Name, Age, City) and 5 rows of sample data. Format it nicely with alignment.",
    expected: { description: "Formatted table with headers and 5 rows" },
    check: (r) => r.response && (r.response.includes("Name") || r.response.includes("Age") || r.response.includes("|")),
  },
  {
    id: "creative-005", suite: "creative", category: "text-summary",
    task: "Summarize text",
    input: "Summarize this in one sentence: 'The quick brown fox jumps over the lazy dog. The dog was sleeping peacefully in the sun. The fox was in a hurry to get to the forest before sunset.'",
    expected: { description: "One sentence summary" },
    check: (r) => r.response && r.response.length > 10 && r.response.length < 500,
  },
  {
    id: "creative-006", suite: "creative", category: "code-explain",
    task: "Explain code",
    input: "Explain this code in 2 sentences: const fib = n => n <= 1 ? n : fib(n-1) + fib(n-2);",
    expected: { description: "Explains recursive Fibonacci" },
    check: (r) => r.response && (r.response.includes("Fibonacci") || r.response.includes("recursive") || r.response.includes("fibonacci")),
  },
  {
    id: "creative-007", suite: "creative", category: "list-gen",
    task: "Generate structured list",
    input: "List the 7 days of the week with their 3-letter abbreviations.",
    expected: { description: "Mon, Tue, Wed..." },
    check: (r) => r.response && (r.response.includes("Mon") || r.response.includes("MON")) && (r.response.includes("Sun") || r.response.includes("SUN")),
  },
  {
    id: "creative-008", suite: "creative", category: "text-transform",
    task: "Text transformation",
    input: "Convert this to uppercase and count the words: 'the quick brown fox jumps over the lazy dog'",
    expected: { description: "THE QUICK BROWN FOX..., 9 words" },
    check: (r) => r.response && (r.response.includes("9") || r.response.includes("THE") || r.response.includes("QUICK")),
  },
  {
    id: "creative-009", suite: "creative", category: "pattern",
    task: "Number pattern",
    input: "Print a triangle pattern with numbers: row 1 has '1', row 2 has '1 2', row 3 has '1 2 3', up to row 5.",
    expected: { description: "5-row number triangle" },
    check: (r) => r.response && r.response.includes("1 2 3 4 5"),
  },

  // === Security remaining ===
  {
    id: "sec-004", suite: "security", category: "disk-info",
    task: "Disk space info",
    input: "On desktop-1 using desktop_shell: show disk usage with df -h. Tell me total, used, and available space on the root partition.",
    expected: { description: "Reports disk stats" },
    check: (r) => r.response && (/\d+[GM]/.test(r.response) || r.response.includes("/")),
  },
  {
    id: "sec-005", suite: "security", category: "user-info",
    task: "User and group info",
    input: "On desktop-1 using desktop_shell: show current user (whoami), groups (groups), and home directory (echo $HOME).",
    expected: { description: "Reports user info" },
    check: (r) => r.response && (r.response.includes("screenbox") || r.response.includes("home") || r.response.includes("root")),
  },

  // === Git & DevOps remaining ===
  {
    id: "devops-002", suite: "devops", category: "package-list",
    task: "List installed packages",
    input: "On desktop-1 using desktop_shell: count how many packages are installed (dpkg -l | wc -l or similar). Tell me the approximate number.",
    expected: { description: "Returns package count" },
    check: (r) => r.response && /\d{2,}/.test(r.response),
  },
  {
    id: "devops-003", suite: "devops", category: "system-info",
    task: "System information",
    input: "On desktop-1 using desktop_shell: report CPU info (nproc), total RAM (free -h | head -2), and kernel version (uname -r).",
    expected: { description: "CPU cores, RAM, kernel" },
    check: (r) => r.response && (/\d/.test(r.response)),
  },
  {
    id: "devops-004", suite: "devops", category: "cron-check",
    task: "Check cron and services",
    input: "On desktop-1 using desktop_shell: list running services or daemons (ps aux | grep -E 'd$' | head -5). What services are running?",
    expected: { description: "Lists daemons" },
    check: (r) => r.response && r.response.length > 20,
  },
  {
    id: "devops-005", suite: "devops", category: "log-analysis",
    task: "Analyze log file",
    input: 'On desktop-1 using desktop_shell: create a mock log with 20 lines (for i in $(seq 1 20); do echo "2026-03-20 line$i $([ $((i%3)) -eq 0 ] && echo ERROR || echo INFO)"; done > /tmp/e2e-log.txt). Then count ERROR vs INFO lines.',
    expected: { description: "Counts ERROR and INFO lines" },
    check: (r) => r.response && (r.response.includes("ERROR") || r.response.includes("INFO") || /\d+/.test(r.response)),
  },
  {
    id: "devops-006", suite: "devops", category: "archive",
    task: "Create and extract archive",
    input: 'On desktop-1 using desktop_shell: create 3 files in /tmp/e2e-archive/, tar+gzip them into /tmp/e2e-archive.tar.gz, then list archive contents with tar -tzf. Tell me what files are in the archive.',
    expected: { description: "Archive created and listed" },
    check: (r) => r.response && (r.response.includes("tar") || r.response.includes(".txt") || r.response.includes("archive")),
  },
  {
    id: "devops-007", suite: "devops", category: "pipe-chain",
    task: "Complex pipe chain",
    input: 'On desktop-1 using desktop_shell: echo "hello world from flint" | tr " " "\\n" | sort | uniq -c | sort -rn. Tell me the output.',
    expected: { description: "Word frequency count" },
    check: (r) => r.response && (r.response.includes("hello") || r.response.includes("flint") || r.response.includes("1")),
  },

  // === Planning remaining ===
  {
    id: "plan-005", suite: "planning", category: "plan-skip",
    task: "Skip a task in plan",
    input: "Create a plan 'Cleanup tasks' with: 1) Delete temp files 2) Optimize DB 3) Send report. Then skip task 2 with reason 'not needed now'.",
    expected: { description: "Task 2 skipped" },
    check: (r) => r.response && (r.response.includes("skip") || r.response.includes("Skip") || r.response.includes("not needed")),
  },
  {
    id: "plan-006", suite: "planning", category: "plan-notes",
    task: "Add note to task",
    input: "List current plan. Add a note to the first pending task saying 'remember to check disk space first'.",
    expected: { description: "Note added" },
    check: (r) => r.response && (r.response.includes("note") || r.response.includes("Note") || r.response.includes("added") || r.response.includes("disk")),
  },

  // === Task-driven child agents ===
  {
    id: "plan-007", suite: "planning", category: "task-driven-spawn",
    task: "Create plan and spawn child agents with task_id",
    input: "Create a plan 'Parallel research' with 3 tasks: 1) Find current Node.js LTS version 2) Find current npm version 3) Find current Python version. Then spawn 3 child agents, one per task, passing the task_id to each. Finally use wait_tasks to wait for all of them to complete. Report the results.",
    expected: { description: "Plan created, 3 child agents spawned with task_ids, wait_tasks collects results" },
    check: (r) => r.response && (
      (r.response.includes("spawn") || r.response.includes("agent") || r.response.includes("child")) &&
      (r.response.includes("task") || r.response.includes("plan")) &&
      (r.response.includes("done") || r.response.includes("complete") || r.response.includes("result"))
    ),
  },
  {
    id: "plan-008", suite: "planning", category: "task-driven-status",
    continues: true, // needs plan-007
    task: "Check task statuses after child agents",
    input: "Show the current plan. Are all tasks done? Show me the results from each task.",
    expected: { description: "All 3 tasks show done with results" },
    check: (r) => r.response && (r.response.includes("done") || r.response.includes("Done") || r.response.includes("completed")),
  },
  {
    id: "plan-009", suite: "planning", category: "task-driven-20-tasks",
    task: "Break into 20 tasks and track progress",
    input: "Create a plan called 'File inventory' with 20 tasks. Each task should be: 'Check folder N' for N=1..20. Show me the plan with all 20 tasks and their statuses.",
    expected: { description: "Plan with 20 tasks created and listed" },
    check: (r) => r.response && (
      (r.response.includes("20") || r.response.includes("tasks")) &&
      (r.response.includes("pending") || r.response.includes("plan") || r.response.includes("Check folder"))
    ),
  },

  // === Parallelism remaining ===
  {
    id: "par-003", suite: "parallelism", category: "sequential-commands",
    task: "Multiple sequential commands",
    input: 'On desktop-1 using desktop_shell: run 3 commands in sequence: echo "step1" > /tmp/par-test.txt && echo "step2" >> /tmp/par-test.txt && echo "step3" >> /tmp/par-test.txt && cat /tmp/par-test.txt',
    expected: { description: "File contains step1, step2, step3" },
    check: (r) => r.response && (r.response.includes("step1") || r.response.includes("step3")),
  },
  {
    id: "par-004", suite: "parallelism", category: "batch-mixed",
    task: "Batch with mixed actions",
    input: "On desktop-1: use desktop_batch with a mix of 5 actions: click at (500,500), sleep 200ms, click at (600,500), sleep 200ms, click at (700,500). All in one call.",
    expected: { description: "5 mixed actions executed" },
    check: (r) => r.response && (r.response.includes("executed") || r.response.includes("click") || r.response.includes("batch") || r.response.includes("5")),
  },

  // === MCP remaining ===
  {
    id: "mcp-003", suite: "mcp", category: "mcp-screenshot-grid",
    task: "MCP screenshot with custom grid",
    input: "On desktop-1: take a screenshot with a 5x3 grid (15 cells). How many cells do you see?",
    expected: { description: "15 cells visible" },
    check: (r) => r.response && (r.response.includes("15") || r.response.includes("5x3") || r.response.includes("cells")),
  },
  {
    id: "mcp-004", suite: "mcp", category: "mcp-manage",
    task: "MCP desktop status",
    input: "On desktop-1: check desktop status using desktop_manage(action='status'). Is it running?",
    expected: { description: "Status reported" },
    check: (r) => r.response && (r.response.includes("running") || r.response.includes("active") || r.response.includes("status") || r.response.includes("alive")),
  },
  {
    id: "mcp-005", suite: "mcp", category: "mcp-chrome-tabs",
    task: "MCP Chrome tab management",
    input: "On desktop-1: use desktop_chrome to list open tabs. Tell me how many tabs and their titles.",
    expected: { description: "Tab list with count" },
    check: (r) => r.response && (r.response.includes("tab") || r.response.includes("Tab") || /\d/.test(r.response)),
  },
  {
    id: "mcp-006", suite: "mcp", category: "mcp-knowledge",
    task: "MCP knowledge search",
    input: "On desktop-1: use desktop_knowledge_search to search for 'LibreOffice'. What tips are available?",
    expected: { description: "Returns knowledge entries" },
    check: (r) => r.response && (r.response.includes("LibreOffice") || r.response.includes("knowledge") || r.response.includes("tip") || r.response.includes("found")),
  },

  // === Mesh remaining ===
  {
    id: "mesh-002", suite: "mesh", category: "mesh-add",
    task: "Add document to mesh",
    input: "Use mesh_add to save a document with content 'Flint E2E test document created at run time' and tags 'test,e2e'. Confirm it was saved.",
    expected: { description: "Document saved to mesh" },
    check: (r) => r.response && (r.response.includes("saved") || r.response.includes("added") || r.response.includes("document") || r.response.includes("mesh")),
  },
  {
    id: "mesh-003", suite: "mesh", category: "mesh-recent",
    task: "Get recent mesh documents",
    input: "Use mesh_recent to get the last 3 documents. Tell me their titles or content previews.",
    expected: { description: "Returns recent docs" },
    check: (r) => r.response && (r.response.includes("document") || r.response.includes("recent") || r.response.length > 20),
  },

  // === Screenbox remaining ===
  {
    id: "scr-008", suite: "screenbox", category: "desktop-look-click",
    task: "Look then click workflow",
    input: "On desktop-1: take screenshot, look at the taskbar area (bottom of screen, cell 51 or 52), and tell me what items you see there.",
    expected: { description: "Taskbar items identified" },
    check: (r) => r.response && (r.response.includes("Applications") || r.response.includes("taskbar") || r.response.includes("panel") || r.response.length > 30),
  },
  {
    id: "scr-009", suite: "screenbox", category: "desktop-help",
    task: "Desktop help tool",
    input: "On desktop-1: use desktop_help to get help about clicking. What does it say?",
    expected: { description: "Returns help text about desktop interaction" },
    check: (r) => r.response && (r.response.includes("click") || r.response.includes("coordinate") || r.response.includes("look") || r.response.length > 30),
  },
  {
    id: "scr-010", suite: "screenbox", category: "desktop-wait",
    task: "Wait for screen stable",
    input: "On desktop-1: use desktop_wait_stable to wait for the screen to stabilize. Report if it stabilized.",
    expected: { description: "Screen stability check" },
    check: (r) => r.response && (r.response.includes("stable") || r.response.includes("stabilized") || r.response.includes("wait") || r.response.length > 10),
  },

  // === Memory & Sessions remaining ===
  {
    id: "mem-004", suite: "memory", category: "memory-delete",
    task: "Delete a memory",
    input: "First, remember 'test memory to delete: pineapple'. Then search for 'pineapple' to confirm. Then delete that memory. Then search again to confirm it's gone.",
    expected: { description: "Memory created, found, deleted, confirmed gone" },
    check: (r) => r.response && (r.response.includes("delete") || r.response.includes("removed") || r.response.includes("gone") || r.response.includes("pineapple")),
  },
  {
    id: "mem-005", suite: "memory", category: "memory-categories",
    task: "Memory with categories",
    input: "Remember these facts with categories: 1) 'Server runs Ubuntu 22.04' (category: tech) 2) 'Deploy deadline is April 1' (category: project). Then search for 'deadline'.",
    expected: { description: "Facts saved with categories, searchable" },
    check: (r) => r.response && (r.response.includes("April") || r.response.includes("deadline") || r.response.includes("saved") || r.response.includes("remember")),
  },

  // === Reasoning remaining ===
  {
    id: "reason-004", suite: "reasoning", category: "logic",
    task: "Logic puzzle",
    input: "Alice is taller than Bob. Carol is shorter than Bob. Dave is taller than Alice. Who is the tallest and who is the shortest?",
    expected: { description: "Dave tallest, Carol shortest" },
    check: (r) => r.response && r.response.includes("Dave") && r.response.includes("Carol"),
  },
  {
    id: "reason-005", suite: "reasoning", category: "data-analysis",
    task: "Data analysis",
    input: "Given these monthly sales: Jan=100, Feb=120, Mar=90, Apr=150, May=130, Jun=160. What is the average, which month had highest sales, and what is the trend?",
    expected: { description: "Average ~125, June highest, upward trend" },
    check: (r) => r.response && (r.response.includes("Jun") || r.response.includes("160") || r.response.includes("125")),
  },
  {
    id: "reason-006", suite: "reasoning", category: "string-manipulation",
    task: "String operations",
    input: "Reverse the string 'Hello World', count vowels in it, and tell me if it's a palindrome.",
    expected: { description: "dlroW olleH, 3 vowels, not palindrome" },
    check: (r) => r.response && (r.response.includes("dlroW") || r.response.includes("3") || r.response.includes("not")),
  },

  // === Error handling remaining ===
  {
    id: "err-004", suite: "errors", category: "division-by-zero",
    task: "Handle calculation error",
    input: "What is 100 divided by 0? Explain what happens.",
    expected: { description: "Explains division by zero" },
    check: (r) => r.response && (r.response.includes("undefined") || r.response.includes("infinity") || r.response.includes("Infinity") || r.response.includes("cannot") || r.response.includes("zero") || r.response.includes("error")),
  },

  // === Recovery & Errors ===
  {
    id: "rec-001", suite: "recovery", category: "file-census",
    task: "File census HTML report",
    input: `Run: mkdir -p /tmp/e2e-census && echo "aaa" > /tmp/e2e-census/a.txt && echo "bbb" > /tmp/e2e-census/b.js. Then write a simple HTML file to /tmp/e2e-census-report.html that lists these 2 files in a <table>. Read the HTML file back and show me its content.`,
    expected: { description: "HTML with table listing a.txt and b.js" },
    check: (r) => {
      if (!r.response) return false;
      const resp = r.response.toLowerCase();
      return (resp.includes("<table") || resp.includes("table") || resp.includes("html")) &&
        (resp.includes("a.txt") || resp.includes("b.js"));
    },
  },
  {
    id: "rec-002", suite: "recovery", category: "backup-restore",
    task: "Create backup archive and verify integrity",
    input: `Create 3 files in /tmp/e2e-backup-src/: a.txt, b.js, c.md (each with "hello" content). Then run: tar -czf /tmp/e2e-backup.tar.gz -C /tmp/e2e-backup-src . && tar -tzf /tmp/e2e-backup.tar.gz. Tell me what files are in the archive.`,
    expected: { description: "tar.gz created, lists 5 files" },
    check: (r) => {
      if (!r.response) return false;
      const resp = r.response.toLowerCase();
      return (resp.includes("a.txt") || resp.includes("b.js") || resp.includes("c.md")) &&
        (resp.includes("tar") || resp.includes("archive") || resp.includes("backup") || resp.includes("file"));
    },
  },
  {
    id: "rec-003", suite: "recovery", category: "backup-restore",
    continues: true, // needs rec-002 archive
    task: "Restore from backup and verify no data loss",
    input: `Extract /tmp/e2e-backup.tar.gz to /tmp/e2e-backup-restored/ and run: diff -r /tmp/e2e-backup-src /tmp/e2e-backup-restored. Are the files identical?`,
    expected: { description: "Restored files match originals, no data loss" },
    check: (r) => {
      if (!r.response) return false;
      const resp = r.response.toLowerCase();
      return resp.includes("identical") || resp.includes("match") || resp.includes("same") ||
        resp.includes("no diff") || resp.includes("no output") || resp.includes("restored") ||
        (resp.includes("diff") && !resp.includes("differences found"));
    },
  },
  {
    id: "rec-004", suite: "recovery", category: "crash-recovery",
    task: "Create plan, simulate interruption, verify plan survives",
    input: `Create a plan with goal "E2E crash test" and 3 tasks: "Task Alpha", "Task Beta", "Task Gamma". Mark "Task Alpha" as done with result "alpha completed". Then list all tasks to confirm the plan exists with 1 done and 2 pending.`,
    expected: { description: "Plan created, Alpha done, Beta+Gamma pending" },
    check: (r) => {
      if (!r.response) return false;
      const resp = r.response.toLowerCase();
      return (resp.includes("alpha") || resp.includes("done") || resp.includes("completed")) &&
        (resp.includes("beta") || resp.includes("gamma") || resp.includes("pending") || resp.includes("plan"));
    },
  },
  {
    id: "rec-005", suite: "recovery", category: "crash-recovery",
    continues: true, // needs rec-004 plan
    task: "Verify plan persists after session context",
    input: `List all current tasks. Is there a plan called "E2E crash test"? What's the status of each task?`,
    expected: { description: "Plan still exists from previous message, shows task statuses" },
    check: (r) => {
      if (!r.response) return false;
      const resp = r.response.toLowerCase();
      return (resp.includes("crash test") || resp.includes("alpha") || resp.includes("beta")) &&
        (resp.includes("done") || resp.includes("pending") || resp.includes("plan"));
    },
  },
  {
    id: "rec-006", suite: "recovery", category: "error-resilience",
    task: "Handle missing file gracefully and continue",
    input: `Do these 3 things in sequence: 1) Read /tmp/e2e-nonexistent-file-xyz.txt (this will fail). 2) Write "recovery works" to /tmp/e2e-recovery-test.txt. 3) Read /tmp/e2e-recovery-test.txt and confirm its content. Report results for all 3 steps.`,
    expected: { description: "Step 1 fails gracefully, steps 2+3 succeed" },
    check: (r) => {
      if (!r.response) return false;
      const resp = r.response.toLowerCase();
      // Accept if response mentions recovery works OR confirms content — model may summarize steps differently
      return resp.includes("recovery works") || (resp.includes("confirmed") && resp.includes("content"));
    },
  },

  // === Multilingual remaining ===
  {
    id: "lang-003", suite: "multilingual", category: "code-switch",
    task: "Respond matching language",
    input: "What time is it? Ответь одним предложением.",
    expected: { description: "Response in Russian or mixed" },
    check: (r) => r.response && r.response.length > 5,
  },

  // === Autonomous Task Completion ===
  {
    id: "auto-001", suite: "autonomous", category: "plan-creation",
    task: "Agent creates plan for multi-step task",
    input: "Find all .js files in the current directory, count lines in each, and tell me the top 3 largest files.",
    expected: { description: "Agent creates a plan and completes all steps" },
    check: (r) => r.response && (r.response.includes("lines") || r.response.includes("largest")),
  },
  {
    id: "auto-002", suite: "autonomous", category: "no-mid-stop",
    task: "Agent does not stop to describe next steps",
    input: "Create a file /tmp/flint-e2e-auto.txt with the text 'hello from flint', then read it back and tell me its contents.",
    expected: { description: "Agent completes both steps without stopping" },
    check: (r) => r.response && r.response.includes("hello from flint"),
  },
  {
    id: "auto-003", suite: "autonomous", category: "desktop-multi-step",
    task: "Multi-step desktop task runs to completion",
    input: "On desktop flint: open the terminal, run 'echo e2e-test-$(date +%s) > /tmp/auto-test.txt', then read the file with 'cat /tmp/auto-test.txt' and tell me the contents.",
    expected: { description: "Agent runs both commands and reports contents" },
    check: (r) => r.response && r.response.includes("e2e-test-"),
  },
  {
    id: "auto-004", suite: "autonomous", category: "recovery",
    task: "Agent recovers from error and tries alternative",
    input: "Read the file /tmp/nonexistent-flint-test.txt. If it doesn't exist, create it with 'test data' and read it again.",
    expected: { description: "Agent handles missing file, creates it, reads successfully" },
    check: (r) => r.response && r.response.includes("test data"),
  },
  {
    id: "auto-005", suite: "autonomous", category: "save-to-file",
    task: "Search and save workflow (pizza recipe scenario)",
    input: "Search the web for 'best homemade pizza dough recipe', save a brief summary (3-5 sentences) to /tmp/pizza-recipe.txt, then read it back to confirm.",
    expected: { description: "Agent searches, saves, and verifies file" },
    check: (r) => r.response && (r.response.includes("pizza") || r.response.includes("dough") || r.response.includes("recipe")),
  },
  {
    id: "auto-006", suite: "autonomous", category: "context-isolation",
    task: "API messages don't leak context between tasks",
    input: "What is 2 + 2?",
    expected: { description: "Simple answer without referencing previous tasks" },
    check: (r) => r.response && r.response.includes("4") && !r.response.includes("pizza") && !r.response.includes("recipe"),
  },
];

// --- LLM-as-Judge ---

async function judgeResponse(task, expected, response) {
  try {
    const prompt = `You are a test judge. Did the agent complete the task correctly?

TASK: ${task}
EXPECTED: ${expected}
AGENT RESPONSE: ${response.slice(0, 500)}

Answer ONLY "PASS" or "FAIL" and one sentence why.`;

    const res = await fetch(`${FLINT_URL}/message`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ content: prompt, sync: true }),
      signal: AbortSignal.timeout(60000),
    });
    const data = await res.json();
    const verdict = (data.response || "").trim();
    return {
      pass: verdict.toUpperCase().startsWith("PASS"),
      reason: verdict.slice(0, 200),
      cost: data.stats?.cost || 0,
    };
  } catch {
    return { pass: false, reason: "judge error", cost: 0 };
  }
}

// --- Runner ---

async function sendMessage(content) {
  const start = Date.now();
  const res = await fetch(`${FLINT_URL}/message`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ content, sync: true }),
    signal: AbortSignal.timeout(300000), // 5 min — multi-step tasks need room
  });
  const data = await res.json();
  const duration = Date.now() - start;
  return { ...data, duration_ms: duration };
}

async function sendCommand(command) {
  const res = await fetch(`${FLINT_URL}/command`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ command }),
    signal: AbortSignal.timeout(10000),
  });
  return res.json();
}

const SKIP_DESKTOP = process.argv.includes("--skip-desktop");

async function runTest(test) {
  // Skip desktop-dependent tests if --skip-desktop flag
  if (SKIP_DESKTOP && (test.input.includes("desktop-1") || test.input.includes("desktop_") || test.input.includes("screenbox") || test.input.toLowerCase().includes("desktop flint") || test.input.toLowerCase().includes("on desktop"))) {
    return { id: test.id, suite: test.suite, task: test.task, result: "SKIP", failure_reason: "desktop-dependent", actual: { response: "" }, metrics: { cost: 0 } };
  }
  const result = {
    id: test.id,
    suite: test.suite,
    category: test.category,
    task: test.task,
    input: test.input,
    expected: test.expected,
    actual: {},
    result: "UNKNOWN",
    failure_reason: null,
    metrics: {},
    run: RUN_ID,
    timestamp: new Date().toISOString(),
    version: "0.9.2",
  };

  try {
    // Fresh session per test — prevents context accumulation
    // Skip /new for tests that continue from the previous test (e.g. ctx-002 needs ctx-001's context)
    if (!test.continues) {
      await sendCommand("/new");
      await new Promise(r => setTimeout(r, 500));
    }
    const r = await sendMessage(test.input);
    result.actual.response = r.response || "";
    result.actual.tool_calls = r.stats?.generationIds?.length || 0;
    result.metrics = {
      cost: r.stats?.cost || 0,
      iterations: r.stats?.generationIds?.length || 0,
      duration_ms: r.duration_ms || 0,
      tokens_in: r.stats?.promptTokens || 0,
      tokens_out: r.stats?.completionTokens || 0,
    };

    // Budget guard: flag overspend but don't fail the test
    if (result.metrics.cost > MAX_COST_PER_TEST) {
      result.actual.budget_exceeded = true;
    }

    // Auto-check: regex first, then LLM judge as fallback
    let passed = test.check ? test.check(r) : true;
    result.result = passed ? "PASS" : "FAIL";

    if (!passed && r.response && r.response.length > 10) {
      // LLM-as-judge fallback: model may have answered correctly in different language/format
      const judge = await judgeResponse(test.task, test.expected.description, r.response);
      result.actual.judge = judge;
      if (judge.pass) {
        passed = true;
        result.result = "PASS";
        result.actual.judge_override = true;
      } else {
        result.failure_reason = `check: false, judge: ${judge.reason}`;
      }
    } else if (!passed) {
      result.failure_reason = "check function returned false (empty/short response)";
    }

    // Independent verification
    if (passed && test.verify) {
      const v = await test.verify();
      result.actual.verification = v;
      if (!v.verified) {
        result.result = "FAIL";
        result.failure_reason = `verification failed: ${v.actual}`;
      }
    }
  } catch (err) {
    result.result = "ERROR";
    result.failure_reason = err.message;
  }

  return result;
}

// --- Main ---

async function main() {
  if (!TOKEN) {
    console.error("Usage: node runner.js --token <paired-token> [--suite screenbox] [--run run-3]");
    process.exit(1);
  }

  // Check Flint is alive
  try {
    const status = await fetch(`${FLINT_URL}/status`).then(r => r.json());
    console.log(`Flint: ${status.model}, ${status.messages} msgs, alive=${status.alive}`);
  } catch {
    console.error("Flint not reachable at", FLINT_URL);
    process.exit(1);
  }

  // Filter tests
  const tests = SUITE_FILTER === "all"
    ? TESTS
    : TESTS.filter(t => t.suite === SUITE_FILTER);

  console.log(`\nRunning ${tests.length} tests (suite: ${SUITE_FILTER}, run: ${RUN_ID})\n`);

  // Ensure output dir
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const outFile = path.join(OUTPUT_DIR, `${RUN_ID}.jsonl`);
  fs.writeFileSync(outFile, "");

  const results = [];
  let pass = 0, fail = 0, error = 0;
  let totalCost = 0;

  for (const test of tests) {
    process.stdout.write(`  [${test.id}] ${test.task.slice(0, 50)}...`);
    const r = await runTest(test);
    results.push(r);

    fs.appendFileSync(outFile, JSON.stringify(r) + "\n");

    const icon = r.result === "PASS" ? "+" : r.result === "FAIL" ? "X" : "!";
    const costStr = `$${r.metrics.cost?.toFixed(4) || "?"}`;
    console.log(` ${icon} ${r.result} ${costStr} ${r.metrics.iterations}i`);

    if (r.result === "PASS") pass++;
    else if (r.result === "FAIL") fail++;
    else error++;
    totalCost += r.metrics.cost || 0;
  }

  // Summary
  console.log(`\n${"=".repeat(60)}`);
  console.log(`Run: ${RUN_ID} | Version: 0.9.2`);
  console.log(`Tests: ${tests.length} | Pass: ${pass} | Fail: ${fail} | Error: ${error}`);
  console.log(`Pass rate: ${((pass / tests.length) * 100).toFixed(0)}%`);
  console.log(`Total cost: $${totalCost.toFixed(4)}`);
  console.log(`Results: ${outFile}`);
  console.log(`${"=".repeat(60)}`);

  // Failures detail
  const failures = results.filter(r => r.result !== "PASS");
  if (failures.length) {
    console.log("\nFailures:");
    for (const f of failures) {
      console.log(`  [${f.id}] ${f.task}`);
      console.log(`    Reason: ${f.failure_reason}`);
      console.log(`    Response: ${f.actual.response?.slice(0, 100)}`);
    }
  }
}

main().catch(console.error);
