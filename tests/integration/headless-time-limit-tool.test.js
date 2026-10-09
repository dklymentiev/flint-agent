// --time-limit while a TOOL is running, not a model call.
//
// headless-time-limit.test.js covers a model call that never returns. Here the
// model has answered and its command is what runs past the limit. The run
// must end at the limit with stop_reason "time" and exit code 2, the command
// must not be left running, and the record must still count the call.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startFakeProvider, runHeadless, intent, toolCall } from "../helpers/headless-fake.js";

describe("--headless: --time-limit during a tool call", () => {
  it("stops a command that outlives the limit: stop_reason time, exit 2", async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "flint-tl-tool-"));
    const pidFile = path.join(scratch, "pid.txt").split(path.sep).join("/");
    const script = path.join(scratch, "sleeper.js").split(path.sep).join("/");
    fs.writeFileSync(script,
      'require("fs").writeFileSync(process.argv[2], String(process.pid)); setTimeout(() => {}, 120000);');

    const provider = await startFakeProvider((body, isStreaming) => {
      if (!isStreaming) return intent(["run_command"], 10);
      if ((body?.messages || []).some((m) => m.role === "tool")) {
        return { streamingParts: [{ content: "the command finished" }] };
      }
      return toolCall("run_command", { command: `node "${script}" "${pidFile}"` });
    });

    let pid = null;
    try {
      const { code, result, stderr, ms } = await runHeadless({
        task: "run the sleeper",
        providerPort: provider.port,
        extraArgs: ["--time-limit", "4"],
        killAfterMs: 45000,
      });
      expect(fs.existsSync(pidFile), "the command never started; stderr: " + stderr.slice(-600)).toBe(true);
      pid = Number(fs.readFileSync(pidFile, "utf-8"));

      expect(code, "exit code; stderr: " + stderr.slice(-600)).toBe(2);
      expect(result?.stop_reason).toBe("time");
      // At the limit, not when the 120 s command would have ended.
      expect(ms).toBeLessThan(30000);
      // The call that was running is in the record.
      expect(result.tool_calls).toBe(1);

      const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
      const until = Date.now() + 5000;
      while (alive() && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
      expect(alive(), "the command survived the time limit").toBe(false);
    } finally {
      provider.close();
      if (pid) { try { process.kill(pid, "SIGKILL"); } catch {} }
      // The folder can stay locked for a moment after the process dies (Windows).
      try { fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch {}
    }
  }, 60000);

  it("a limit shorter than the first provider call ends the run as 'time'", async () => {
    // The limit is over before any call of the turn has been answered,
    // whichever call that is (the classifier's or the agent's own). The
    // answer that arrives afterwards is not the run's result.
    const provider = await startFakeProvider((body, isStreaming) => {
      if (!isStreaming) return { ...intent([], 2), delayMs: 3000 };
      return { streamingParts: [{ content: "too late" }], delayMs: 3000 };
    });
    try {
      const { code, result, stderr } = await runHeadless({
        task: "say ready",
        providerPort: provider.port,
        extraArgs: ["--time-limit", "0.2"],
        killAfterMs: 45000,
      });
      expect(code, "exit code; stderr: " + stderr.slice(-600)).toBe(2);
      expect(result?.stop_reason).toBe("time");
      expect(result.response).not.toContain("too late");
      expect(result.duration_ms).toBeLessThan(2500);
    } finally {
      provider.close();
    }
  }, 60000);
});
