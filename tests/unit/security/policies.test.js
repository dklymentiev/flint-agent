import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { loadPolicy } from "../../../src/security/policies.js";

describe("policies", () => {
  const originalEnv = process.env.AGENT_SECURITY_POLICY;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.AGENT_SECURITY_POLICY;
    } else {
      process.env.AGENT_SECURITY_POLICY = originalEnv;
    }
  });

  describe("loadPolicy", () => {
    it("returns 'normal' policy by default when no config or env var", () => {
      delete process.env.AGENT_SECURITY_POLICY;
      const policy = loadPolicy({});
      expect(policy.name).toBe("normal");
    });

    it("returns policy matching config.securityPolicy", () => {
      const policy = loadPolicy({ securityPolicy: "strict" });
      expect(policy.name).toBe("strict");
    });

    it("prefers config.securityPolicy over env var", () => {
      process.env.AGENT_SECURITY_POLICY = "permissive";
      const policy = loadPolicy({ securityPolicy: "strict" });
      expect(policy.name).toBe("strict");
    });

    it("falls back to env var when config has no securityPolicy", () => {
      process.env.AGENT_SECURITY_POLICY = "permissive";
      const policy = loadPolicy({});
      expect(policy.name).toBe("permissive");
    });

    it("falls back to 'normal' for unknown policy name", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      const policy = loadPolicy({ securityPolicy: "nonexistent" });
      expect(policy.name).toBe("normal");
      expect(spy).toHaveBeenCalledWith(expect.stringContaining("nonexistent"));
      spy.mockRestore();
    });
  });

  describe("profile structure", () => {
    const profiles = ["strict", "normal", "permissive"];

    for (const profileName of profiles) {
      describe(`${profileName} profile`, () => {
        let policy;
        beforeEach(() => {
          policy = loadPolicy({ securityPolicy: profileName });
        });

        it("has the correct name", () => {
          expect(policy.name).toBe(profileName);
        });

        it("has criticalDenylist array with .ssh, .gnupg, .aws entries", () => {
          expect(Array.isArray(policy.criticalDenylist)).toBe(true);
          expect(policy.criticalDenylist.length).toBeGreaterThanOrEqual(3);
          const joined = policy.criticalDenylist.join("|");
          expect(joined).toContain(".ssh");
          expect(joined).toContain(".gnupg");
          expect(joined).toContain(".aws");
        });

        it("has secretPatterns array", () => {
          expect(Array.isArray(policy.secretPatterns)).toBe(true);
          expect(policy.secretPatterns.length).toBeGreaterThan(0);
          for (const p of policy.secretPatterns) {
            expect(p).toBeInstanceOf(RegExp);
          }
        });

        it("has secretFilePatterns array", () => {
          expect(Array.isArray(policy.secretFilePatterns)).toBe(true);
          expect(policy.secretFilePatterns.length).toBeGreaterThan(0);
        });

        it("has commandDenyPatterns array", () => {
          expect(Array.isArray(policy.commandDenyPatterns)).toBe(true);
          expect(policy.commandDenyPatterns.length).toBeGreaterThan(0);
        });

        it("has dangerousCommandPatterns array", () => {
          expect(Array.isArray(policy.dangerousCommandPatterns)).toBe(true);
        });

        it("has network config with rateLimit", () => {
          expect(policy.network).toBeDefined();
          expect(typeof policy.network.blockPrivateIPs).toBe("boolean");
          expect(typeof policy.network.blockNonHttpProtocols).toBe("boolean");
          expect(policy.network.rateLimit).toBeDefined();
          expect(typeof policy.network.rateLimit.maxPerMinute).toBe("number");
          expect(typeof policy.network.rateLimit.windowMs).toBe("number");
        });

        it("has child config with maxDepth", () => {
          expect(policy.child).toBeDefined();
          expect(typeof policy.child.maxDepth).toBe("number");
        });

        it("has extraDenyPaths array", () => {
          expect(Array.isArray(policy.extraDenyPaths)).toBe(true);
        });
      });
    }
  });

  describe("profile differences", () => {
    it("strict has lower rate limit than normal", () => {
      const strict = loadPolicy({ securityPolicy: "strict" });
      const normal = loadPolicy({ securityPolicy: "normal" });
      expect(strict.network.rateLimit.maxPerMinute).toBeLessThan(normal.network.rateLimit.maxPerMinute);
    });

    it("strict has lower maxDepth than normal", () => {
      const strict = loadPolicy({ securityPolicy: "strict" });
      const normal = loadPolicy({ securityPolicy: "normal" });
      expect(strict.child.maxDepth).toBeLessThan(normal.child.maxDepth);
    });

    it("strict has extraDenyPaths for shell config files", () => {
      const strict = loadPolicy({ securityPolicy: "strict" });
      expect(strict.extraDenyPaths.length).toBeGreaterThan(0);
      const joined = strict.extraDenyPaths.join("|");
      expect(joined).toContain(".bashrc");
    });

    it("permissive has no dangerousCommandPatterns", () => {
      const permissive = loadPolicy({ securityPolicy: "permissive" });
      expect(permissive.dangerousCommandPatterns).toHaveLength(0);
    });

    it("permissive does not block private IPs", () => {
      const permissive = loadPolicy({ securityPolicy: "permissive" });
      expect(permissive.network.blockPrivateIPs).toBe(false);
    });
  });
});
