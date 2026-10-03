// Process slice: background processes tracking
import { spawn } from "node:child_process";

export const createProcessSlice = (set, get) => ({
  processes: [],      // [{ id, cmd, status, startTime, pid, output[], exitCode }]
  nextProcessId: 1,

  addProcess({ cmd, command, pid }) {
    const { processes, nextProcessId } = get();
    const proc = {
      id: nextProcessId,
      cmd,
      command: command || cmd, // what the screen shows; cmd may be a label
      pid: pid || null,
      status: "running",  // "running" | "done" | "failed" | "killed"
      startTime: Date.now(),
      output: [],          // last N lines of combined stdout+stderr
      exitCode: null,
    };
    set({
      processes: [...processes, proc],
      nextProcessId: nextProcessId + 1,
    });
    return nextProcessId;
  },

  appendProcessOutput(id, line) {
    const { processes } = get();
    set({
      processes: processes.map((p) => {
        if (p.id !== id) return p;
        // Dedup: collapse consecutive identical lines into count
        const last = p.output[p.output.length - 1];
        if (last && last.replace(/\s*\(x\d+\)$/, "") === line) {
          const match = last.match(/\(x(\d+)\)$/);
          const count = match ? parseInt(match[1], 10) + 1 : 2;
          const deduped = [...p.output];
          deduped[deduped.length - 1] = `${line} (x${count})`;
          return { ...p, output: deduped };
        }
        const output = [...p.output, line];
        // Keep last 50 lines
        return { ...p, output: output.length > 50 ? output.slice(-50) : output };
      }),
    });
  },

  finishProcess(id, exitCode, status) {
    const { processes } = get();
    set({
      processes: processes.map((p) => {
        if (p.id !== id) return p;
        // A process stopped with /kill exits non-zero (taskkill gives 1). It was
        // killed, not failed: keep that, or the agent reads it as a crash
        // (owner demo, 2026-10-01).
        if (p.status === "killed" && !status) return { ...p, exitCode };
        return { ...p, exitCode, status: status || (exitCode === 0 ? "done" : "failed") };
      }),
    });
  },

  killProcess(id) {
    const { processes } = get();
    const proc = processes.find((p) => p.id === id);
    if (proc && proc.pid && proc.status === "running") {
      try {
        if (process.platform === "win32") {
          spawn("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
        } else {
          process.kill(proc.pid, "SIGTERM");
        }
      } catch {}
      set({
        processes: processes.map((p) =>
          p.id === id ? { ...p, status: "killed" } : p
        ),
      });
      return true;
    }
    return false;
  },

  killAllRunning() {
    const { processes } = get();
    const running = processes.filter((p) => p.status === "running" && p.pid);
    for (const proc of running) {
      try {
        if (process.platform === "win32") {
          spawn("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
        } else {
          process.kill(proc.pid, "SIGTERM");
        }
      } catch {}
    }
    set({
      processes: processes.map((p) =>
        p.status === "running" ? { ...p, status: "killed" } : p
      ),
    });
    return running.length;
  },

  // Internal timers / scheduled jobs
  timers: [],  // [{ id, name, intervalMs, nextRun, lastRun, status }]

  registerTimer({ id, name, intervalMs }) {
    const { timers } = get();
    const existing = timers.find((t) => t.id === id);
    if (existing) return;
    set({
      timers: [...timers, {
        id,
        name,
        intervalMs,
        nextRun: Date.now() + intervalMs,
        lastRun: null,
        status: "active",
      }],
    });
  },

  updateTimerRun(id) {
    const { timers } = get();
    set({
      timers: timers.map((t) =>
        t.id === id ? { ...t, lastRun: Date.now(), nextRun: Date.now() + t.intervalMs } : t
      ),
    });
  },

  removeTimer(id) {
    const { timers } = get();
    set({ timers: timers.filter((t) => t.id !== id) });
  },
});
