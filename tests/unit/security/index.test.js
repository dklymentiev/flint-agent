import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the permissions module since it's an external dependency
//
// getOnboardingAnswer is here because initSecurity now reads the chosen level
// through it to decide which command patterns ask. Without it in the mock,
// initSecurity throws inside its own try/catch and the module calls
// process.exit(78) — the whole file then fails with "Security init failed",
// which reads as a security-module bug and is really a missing mock export.
vi.mock("../../../src/tools/permissions.js", () => ({
  addBeforeHook: vi.fn(),
  addAfterHook: vi.fn(),
  getOnboardingAnswer: vi.fn(() => null),
}));

// Mock audit to avoid file system side effects
vi.mock("../../../src/security/audit.js", () => ({
  initAudit: vi.fn(),
  auditLog: vi.fn(),
  createAuditBeforeHook: vi.fn(() => () => null),
  createAuditAfterHook: vi.fn(() => () => null),
}));

// Mock watchdog to avoid timers
vi.mock("../../../src/security/watchdog.js", () => ({
  startWatchdog: vi.fn(() => vi.fn()),
}));

import { initSecurity, getSecurityApi } from "../../../src/security/index.js";
import { addBeforeHook, addAfterHook } from "../../../src/tools/permissions.js";
import { initAudit } from "../../../src/security/audit.js";
import { startWatchdog } from "../../../src/security/watchdog.js";

describe("index (initSecurity)", () => {
  const originalEnv = process.env.AGENT_SECURITY_DISABLE;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.AGENT_SECURITY_DISABLE;
    } else {
      process.env.AGENT_SECURITY_DISABLE = originalEnv;
    }
    vi.clearAllMocks();
  });

  describe("AGENT_SECURITY_DISABLE", () => {
    it("returns disabled api when AGENT_SECURITY_DISABLE=1", () => {
      process.env.AGENT_SECURITY_DISABLE = "1";
      const api = initSecurity({}, {});
      expect(api.disabled).toBe(true);
      expect(api.token).toBeNull();
      expect(api.delimiter).toBeNull();
      expect(api.authMiddleware).toBeNull();
      expect(api.policy).toBeNull();
      expect(typeof api.stopWatchdog).toBe("function");
    });

    it("does not register any hooks when disabled", () => {
      process.env.AGENT_SECURITY_DISABLE = "1";
      initSecurity({}, {});
      expect(addBeforeHook).not.toHaveBeenCalled();
      expect(addAfterHook).not.toHaveBeenCalled();
    });
  });

  describe("normal initialization", () => {
    let api;

    beforeEach(() => {
      delete process.env.AGENT_SECURITY_DISABLE;
      api = initSecurity({}, { sessionsDir: "/tmp/test-sessions" });
    });

    // No token-file key by default: programs pair (api-pairing-default.test.js).
    it("returns no token-file key unless FLINT_API_TOKEN_FILE=1", () => {
      expect(api.token).toBe(null);
    });

    it("returns an object with delimiter (tool_result_XXXX format)", () => {
      expect(api.delimiter).toMatch(/^tool_result_[0-9a-f]{12}$/);
    });

    it("returns an object with authMiddleware function", () => {
      expect(typeof api.authMiddleware).toBe("function");
    });

    it("returns an object with stopWatchdog function", () => {
      expect(typeof api.stopWatchdog).toBe("function");
    });

    it("returns an object with policy", () => {
      expect(api.policy).toBeDefined();
      expect(api.policy.name).toBeDefined();
    });

    it("has disabled=false", () => {
      expect(api.disabled).toBe(false);
    });

    it("registers 5 beforeHooks", () => {
      expect(addBeforeHook).toHaveBeenCalledTimes(5);
    });

    it("registers 2 afterHooks", () => {
      expect(addAfterHook).toHaveBeenCalledTimes(2);
    });

    it("initializes audit", () => {
      expect(initAudit).toHaveBeenCalled();
    });

    it("starts watchdog", () => {
      expect(startWatchdog).toHaveBeenCalled();
    });
  });

  describe("getSecurityApi", () => {
    it("returns the same api object after initSecurity", () => {
      delete process.env.AGENT_SECURITY_DISABLE;
      const api = initSecurity({}, { sessionsDir: "/tmp/test-sessions" });
      expect(getSecurityApi()).toBe(api);
    });
  });

  describe("error handling", () => {
    it("returns disabled api with error message on init failure", () => {
      delete process.env.AGENT_SECURITY_DISABLE;
      // Force an error by making initAudit throw
      initAudit.mockImplementationOnce(() => {
        throw new Error("test init error");
      });

      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {});
      const api = initSecurity({}, {});
      // initSecurity calls process.exit(78) on critical failure
      expect(exitSpy).toHaveBeenCalledWith(78);
      spy.mockRestore();
      exitSpy.mockRestore();
    });
  });
});
