// Stopping a command on Unix stops what the shell started, not only the
// shell: `sleep 45; echo` outlived a stopped turn and held its output open
// until it finished on its own (Linux, 2026-10-02).
import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { killUnixTree } from "../../../src/tools/process-tools.js";

describe.skipIf(process.platform === "win32")("killUnixTree", () => {
  it("ends the shell and the command under it, so the output closes at once", async () => {
    const child = spawn("sh", ["-c", "sleep 30; echo late"], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    await new Promise((r) => setTimeout(r, 300));
    const started = Date.now();
    killUnixTree(child.pid);
    await new Promise((r) => child.on("close", r));
    expect(Date.now() - started).toBeLessThan(3000);
    expect(out).not.toContain("late");
  });
});
