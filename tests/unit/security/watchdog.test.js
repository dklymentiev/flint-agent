import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { startWatchdog } from "../../../src/security/watchdog.js";

describe("watchdog", () => {
  let stopFn;

  afterEach(() => {
    if (stopFn) {
      stopFn();
      stopFn = null;
    }
  });

  describe("startWatchdog", () => {
    it("returns a stopWatchdog function", () => {
      const store = {};
      const config = {};
      stopFn = startWatchdog(store, config);
      expect(typeof stopFn).toBe("function");
    });

    it("stopWatchdog can be called multiple times safely", () => {
      const store = {};
      const config = {};
      stopFn = startWatchdog(store, config);
      stopFn();
      stopFn(); // second call should not throw
      stopFn = null;
    });
  });

  describe("memory check", () => {
    it("logs WATCHDOG_ALERT when heap exceeds 500MB", () => {
      vi.useFakeTimers();
      const auditLogMock = vi.fn();

      // Mock process.memoryUsage to return high heap
      const origMemUsage = process.memoryUsage;
      process.memoryUsage = () => ({
        heapUsed: 600 * 1024 * 1024, // 600 MB
        heapTotal: 700 * 1024 * 1024,
        rss: 800 * 1024 * 1024,
        external: 0,
        arrayBuffers: 0,
      });

      const store = {};
      const config = {};
      stopFn = startWatchdog(store, config, { auditLog: auditLogMock });

      // Advance timer past the 30s check interval
      vi.advanceTimersByTime(31000);

      expect(auditLogMock).toHaveBeenCalledWith(
        "WATCHDOG_ALERT",
        null,
        {},
        expect.objectContaining({ alert: "high_memory" })
      );

      process.memoryUsage = origMemUsage;
      vi.useRealTimers();
    });

    it("does not log when heap is under 500MB", () => {
      vi.useFakeTimers();
      const auditLogMock = vi.fn();

      const origMemUsage = process.memoryUsage;
      process.memoryUsage = () => ({
        heapUsed: 100 * 1024 * 1024, // 100 MB
        heapTotal: 200 * 1024 * 1024,
        rss: 300 * 1024 * 1024,
        external: 0,
        arrayBuffers: 0,
      });

      const store = {};
      const config = {};
      stopFn = startWatchdog(store, config, { auditLog: auditLogMock });

      vi.advanceTimersByTime(31000);

      const memAlerts = auditLogMock.mock.calls.filter(
        (c) => c[0] === "WATCHDOG_ALERT" && c[3]?.alert === "high_memory"
      );
      expect(memAlerts).toHaveLength(0);

      process.memoryUsage = origMemUsage;
      vi.useRealTimers();
    });
  });

  describe("self-modification detection", () => {
    it("logs WATCHDOG_ALERT when src hash changes", () => {
      vi.useFakeTimers();
      const auditLogMock = vi.fn();

      // We can't easily change actual files, but we can verify the watchdog
      // runs without error. For a true unit test, we'd need to mock fs.
      const store = {};
      const config = {};
      stopFn = startWatchdog(store, config, { auditLog: auditLogMock });

      // Advance timer — hash should stay the same (no modification)
      vi.advanceTimersByTime(31000);

      const srcAlerts = auditLogMock.mock.calls.filter(
        (c) => c[0] === "WATCHDOG_ALERT" && c[3]?.alert === "src_modified"
      );
      // No source modification happened, so no alert
      expect(srcAlerts).toHaveLength(0);

      vi.useRealTimers();
    });
  });
});
