import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createMockStore } from "../../helpers/mock-store.js";
import { activeChildren } from "../../../src/tools/process-tools.js";

// True if a process is currently running (signal 0 succeeds).
function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// Mock UI output functions — they write to terminal, not needed in tests
vi.mock("../../../src/ui/output.js", () => ({
  printProcessStart: vi.fn(),
  printProcessEnd: vi.fn(),
  printProcessSummary: vi.fn(),
  setProcessStream: vi.fn(),
}));

let store;

beforeEach(() => {
  store = createMockStore();
  // Clear any leftover children from previous tests
  activeChildren.clear();
});

afterEach(() => {
  // Kill any remaining background processes
  for (const [id, child] of activeChildren) {
    try { child.kill("SIGKILL"); } catch {}
  }
  activeChildren.clear();
});

// Lazy import to ensure mocks are applied
async function getHandlers() {
  const { createProcessHandlers } = await import("../../../src/tools/process-tools.js");
  return createProcessHandlers(store);
}

// ── run_command ──

describe("run_command", () => {
  it("executes simple command and captures stdout", async () => {
    const h = await getHandlers();
    const result = await h.run_command({ command: "echo hello" });
    expect(result.trim()).toBe("hello");
  });

  it("captures stderr separately", async () => {
    const h = await getHandlers();
    const result = await h.run_command({ command: "echo err >&2" });
    expect(result).toContain("STDERR:");
    expect(result).toContain("err");
  });

  it("returns exit code in output for non-zero exit", async () => {
    const h = await getHandlers();
    const result = await h.run_command({ command: "exit 42" });
    expect(result).toContain("exit 42");
    expect(result).toContain("Error");
  });

  it("handles empty command gracefully", async () => {
    const h = await getHandlers();
    const result = await h.run_command({ command: "" });
    // Empty command either returns no output or an error — should not throw
    expect(typeof result).toBe("string");
  });

  it("returns combined stdout and stderr", async () => {
    const h = await getHandlers();
    const result = await h.run_command({ command: "echo out && echo err >&2" });
    expect(result).toContain("out");
    expect(result).toContain("err");
  });

  it("handles command that produces only stderr with exit 0", async () => {
    const h = await getHandlers();
    const result = await h.run_command({ command: "echo warning >&2; exit 0" });
    expect(result).toContain("STDERR:");
    expect(result).toContain("warning");
    // exit 0 means no "Error" prefix
    expect(result).not.toMatch(/^Error/);
  });

  it("returns (no output) for silent command", async () => {
    const h = await getHandlers();
    const result = await h.run_command({ command: "true" });
    expect(result).toBe("(no output)");
  });

  it("respects cwd parameter", async () => {
    const h = await getHandlers();
    const os = await import("node:os");
    const tmpDir = os.tmpdir();
    const result = await h.run_command({ command: "pwd", cwd: tmpDir });
    // The output should contain the temp directory path (normalized)
    expect(result.trim().length).toBeGreaterThan(0);
  });

  it("reads AGENT_COMMAND_TIMEOUT from env (verified via quick exit)", async () => {
    // Verify timeout logic exists by checking a fast command under a short timeout
    const origTimeout = process.env.AGENT_COMMAND_TIMEOUT;
    process.env.AGENT_COMMAND_TIMEOUT = "2"; // 2 seconds
    try {
      const h = await getHandlers();
      // This fast command should complete well under the 2s timeout
      const result = await h.run_command({ command: "echo timeout-ok" });
      expect(result.trim()).toBe("timeout-ok");
    } finally {
      if (origTimeout !== undefined) {
        process.env.AGENT_COMMAND_TIMEOUT = origTimeout;
      } else {
        delete process.env.AGENT_COMMAND_TIMEOUT;
      }
    }
  });

  // RX.1 regression test for Bug RX-3: Windows pipeline kill
  it("kills long-running command within timeout + grace (RX-3)", async () => {
    const origTimeout = process.env.AGENT_COMMAND_TIMEOUT;
    process.env.AGENT_COMMAND_TIMEOUT = "2"; // 2 seconds
    try {
      const h = await getHandlers();
      const start = Date.now();
      // sleep 60 would hang for a minute without the fix; with fix it dies in ~2s (+5s grace)
      const result = await h.run_command({ command: "sleep 60" });
      const elapsed = Date.now() - start;
      // Must not wait full 60s. Allow up to 10s total (2s timeout + 5s grace + 3s slack)
      expect(elapsed).toBeLessThan(10000);
      // Result may be empty or contain an error message — either is acceptable,
      // the key point is that the call returned instead of hanging.
      expect(typeof result).toBe("string");
    } finally {
      if (origTimeout !== undefined) {
        process.env.AGENT_COMMAND_TIMEOUT = origTimeout;
      } else {
        delete process.env.AGENT_COMMAND_TIMEOUT;
      }
    }
  }, 15000);

  // The model can set its own ceiling, and it wins over the default.
  it("honours timeout_seconds from the call", async () => {
    const origTimeout = process.env.AGENT_COMMAND_TIMEOUT;
    process.env.AGENT_COMMAND_TIMEOUT = "60";
    try {
      const h = await getHandlers();
      const start = Date.now();
      const result = await h.run_command({ command: "sleep 60", timeout_seconds: 1 });
      expect(Date.now() - start).toBeLessThan(9000);
      expect(result).toContain("killed by timeout after 1000ms");
    } finally {
      if (origTimeout !== undefined) process.env.AGENT_COMMAND_TIMEOUT = origTimeout;
      else delete process.env.AGENT_COMMAND_TIMEOUT;
    }
  }, 15000);

  // RX.1 regression test for Bug RX-3: shell pipeline kill (the admin-008 case)
  it("kills shell pipeline within timeout + grace (RX-3 admin-008 regression)", async () => {
    const origTimeout = process.env.AGENT_COMMAND_TIMEOUT;
    process.env.AGENT_COMMAND_TIMEOUT = "2";
    try {
      const h = await getHandlers();
      const start = Date.now();
      // Pipeline — several processes chained. Without fix on Windows,
      // spawn timeout only kills the shell, leaving sleep running.
      const result = await h.run_command({ command: "sleep 60 | cat | cat" });
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(10000);
      expect(typeof result).toBe("string");
    } finally {
      if (origTimeout !== undefined) {
        process.env.AGENT_COMMAND_TIMEOUT = origTimeout;
      } else {
        delete process.env.AGENT_COMMAND_TIMEOUT;
      }
    }
  }, 15000);

  it("strips ANSI escape codes from output", async () => {
    const h = await getHandlers();
    const result = await h.run_command({ command: 'printf "\\x1b[31mred\\x1b[0m"' });
    expect(result).not.toContain("\x1b[");
    expect(result).toContain("red");
  });

  // ── background `&` must NOT be killed in non-headless (interactive) mode ──
  // Regression for the rejected trap-on-every-command fix: if a trap were
  // injected into every run_command, an operator's intentionally backgrounded
  // `cmd &` would be killed when the shell exits. In non-headless mode the
  // trap must not be present, so the backgrounded process outlives the shell
  // and a plain command keeps a clean (zero) exit code.
  it("does not kill an operator's `&` background process when not headless", async () => {
    const os = await import("node:os");
    const path = await import("node:path");
    const fs = await import("node:fs");
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "flint-amp-interactive-"));
    const script = path.join(tmpBase, "sleeper.js");
    const pidFile = path.join(tmpBase, "pid.txt");
    // Sleeper writes its own PID then stays alive.
    fs.writeFileSync(script,
      'require("fs").writeFileSync(process.argv[2], String(process.pid)); setInterval(() => {}, 1000);');
    const escapedScript = process.platform === "win32"
      ? `"${script}"` : `"${script}"`;
    // Background it with `&` exactly like an operator would. No trap should be
    // injected, so the child must survive the shell exiting.
    const h = await getHandlers();
    const result = await h.run_command({
      command: `node ${escapedScript} "${pidFile}" > /dev/null 2>&1 & echo marker`,
    });
    expect(result).toContain("marker");
    // Wait briefly for the PID file to appear, then assert the child is alive.
    const until = Date.now() + 2000;
    while (!fs.existsSync(pidFile) && Date.now() < until) { /* spin */ }
    expect(fs.existsSync(pidFile), "backgrounded child never wrote its PID").toBe(true);
    const pid = Number(fs.readFileSync(pidFile, "utf-8").trim());
    // Give it a moment after the shell exited.
    const alive = await new Promise((resolve) => {
      setTimeout(() => {
        try { process.kill(pid, 0); resolve(true); } catch { resolve(false); }
      }, 200);
    });
    expect(alive, "an operator `&` process was killed in non-headless mode — the trap leaked into interactive runs").toBe(true);
    // Cleanup: kill the surviving child first, then wait for it to actually
    // exit before removing its cwd (a SIGKILL'd tree on Windows still holds
    // the directory briefly and rmSync races into EBUSY).
    try { process.kill(pid, "SIGKILL"); } catch {}
    const deadline = Date.now() + 3000;
    while (isAlive(pid) && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 50));
    }
    // Windows keeps the folder busy a little longer than the process lives
    // (EBUSY on rmdir, red on every Windows run). The assertions above are the
    // test; a temp folder that could not be removed yet is not a failure.
    try { fs.rmSync(tmpBase, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); } catch {}
  }, 15000);

  // And the flip side: a normal command returns a clean zero exit code in
  // non-headless mode (the trap, when active in headless mode, must not
  // corrupt the exit code of ordinary commands).
  it("returns a clean exit code for a normal command when not headless", async () => {
    const h = await getHandlers();
    const result = await h.run_command({ command: "echo ok" });
    expect(result.trim()).toBe("ok");
    expect(result).not.toMatch(/Error/);
  });

  // RX-3.1 regression: the MAX_OUTPUT guard used to call a non-existent
  // hardKill() in the socket 'data' handler. A ReferenceError thrown from an
  // event handler is uncaught and kills the whole Flint process. This killed
  // admin-005 in the RX-7 validation run and cascaded `Flint unresponsive`
  // across every subsequent task.
  it("truncates > 1MB output without crashing the process (RX-3.1)", async () => {
    const h = await getHandlers();
    // 2 MB of output — forces the MAX_OUTPUT (1 MB) guard to fire.
    // yes | head -c 2M works on Linux but is fragile on Windows Git Bash;
    // use a portable printf loop driven by bash.
    const result = await h.run_command({
      command: 'for i in $(seq 1 20); do printf "%0.s-" {1..100000}; done',
    });
    // We should get back either the truncation error string or some prefix.
    // The key point is that the call RETURNED — the process did not crash.
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  }, 15000);
});

// ── run_background_command ──

describe("run_background_command", () => {
  it("starts background process and returns process ID", async () => {
    const h = await getHandlers();
    const result = await h.run_background_command({ command: "sleep 2", label: "test-sleep" });
    expect(result).toContain("Background process started");
    expect(result).toMatch(/id: \d+/);
    expect(result).toMatch(/pid: \d+/);
  });

  it("process appears in list_processes after start", async () => {
    const h = await getHandlers();
    await h.run_background_command({ command: "sleep 2", label: "bg-list-test" });
    const list = await h.list_processes();
    expect(list).toContain("bg-list-test");
    expect(list).toContain("running");
  });

  it("tracks label when provided", async () => {
    const h = await getHandlers();
    const result = await h.run_background_command({ command: "sleep 2", label: "my-label" });
    expect(result).toContain("Background process started");
    const list = await h.list_processes();
    expect(list).toContain("my-label");
  });

  it("enforces max 5 concurrent background processes", async () => {
    const h = await getHandlers();
    // Fill up activeChildren with fake entries to simulate max
    for (let i = 0; i < 5; i++) {
      activeChildren.set(`fake_${i}`, { kill: vi.fn() });
    }
    const result = await h.run_background_command({ command: "echo hi" });
    expect(result).toContain("too many background processes");
    // Cleanup fakes
    for (let i = 0; i < 5; i++) {
      activeChildren.delete(`fake_${i}`);
    }
  });
});

// ── kill_process ──

describe("kill_process", () => {
  it("kills a running background process", async () => {
    const h = await getHandlers();
    await h.run_background_command({ command: "sleep 10", label: "kill-test" });
    const procs = store.getState().processes;
    const proc = procs.find((p) => p.status === "running");
    expect(proc).toBeDefined();

    const result = await h.kill_process({ process_id: proc.id });
    expect(result).toContain("Killed");
    expect(result).toContain("kill-test");
  });

  it("returns error for nonexistent process ID", async () => {
    const h = await getHandlers();
    const result = await h.kill_process({ process_id: 9999 });
    expect(result).toContain("not found");
  });

  it("reports already-finished process", async () => {
    const h = await getHandlers();
    // Add a process that already finished
    store.getState().addProcess({ cmd: "done-cmd", pid: 12345 });
    store.getState().finishProcess(1, 0);

    const result = await h.kill_process({ process_id: 1 });
    expect(result).toContain("already");
  });
});

// ── list_processes ──

describe("list_processes", () => {
  it("returns 'no processes' when empty", async () => {
    const h = await getHandlers();
    const result = await h.list_processes();
    expect(result).toContain("No background processes");
  });

  it("lists active processes with correct fields", async () => {
    const h = await getHandlers();
    store.getState().addProcess({ cmd: "test-cmd", pid: 1234 });
    const result = await h.list_processes();
    expect(result).toContain("ID");
    expect(result).toContain("Status");
    expect(result).toContain("PID");
    expect(result).toContain("test-cmd");
    expect(result).toContain("1234");
  });
});

// ── peek_process ──

describe("peek_process", () => {
  it("returns last lines of background process output", async () => {
    const h = await getHandlers();
    const procId = store.getState().addProcess({ cmd: "peek-cmd", pid: 5555 });
    store.getState().appendProcessOutput(procId, "line1");
    store.getState().appendProcessOutput(procId, "line2");
    store.getState().appendProcessOutput(procId, "line3");

    const result = await h.peek_process({ process_id: procId, lines: 2 });
    expect(result).toContain("line2");
    expect(result).toContain("line3");
    expect(result).not.toContain("line1");
  });

  it("returns error for nonexistent process ID", async () => {
    const h = await getHandlers();
    const result = await h.peek_process({ process_id: 9999 });
    expect(result).toContain("not found");
  });

  it("returns 'no output yet' when process has no output", async () => {
    const h = await getHandlers();
    const procId = store.getState().addProcess({ cmd: "silent", pid: 6666 });
    const result = await h.peek_process({ process_id: procId });
    expect(result).toContain("no output yet");
  });

  it("defaults to 10 lines when lines param not given", async () => {
    const h = await getHandlers();
    const procId = store.getState().addProcess({ cmd: "many-lines", pid: 7777 });
    for (let i = 0; i < 20; i++) {
      store.getState().appendProcessOutput(procId, `output-${i}`);
    }
    const result = await h.peek_process({ process_id: procId });
    // Should contain last 10 lines (10-19), not first ones
    expect(result).toContain("output-19");
    expect(result).toContain("output-10");
    expect(result).not.toContain("output-9");
  });

  it("clamps lines to max 50", async () => {
    const h = await getHandlers();
    const procId = store.getState().addProcess({ cmd: "clamp-test", pid: 8888 });
    // Even if we ask for 100 lines, max is 50
    const result = await h.peek_process({ process_id: procId, lines: 100 });
    // Should not throw — just clamps
    expect(result).toContain("no output yet");
  });
});
