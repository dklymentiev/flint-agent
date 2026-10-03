import { describe, it, expect, vi, beforeEach } from "vitest";
import { createNetworkGuardHook } from "../../../src/security/network-guard.js";
import { loadPolicy } from "../../../src/security/policies.js";

describe("network-guard", () => {
  let hook;
  let policy;

  beforeEach(() => {
    policy = loadPolicy({ securityPolicy: "normal" });
    hook = createNetworkGuardHook(policy);
  });

  describe("non-network tools", () => {
    it("returns null for non-network tools", () => {
      expect(hook("read_file", { path: "/tmp/test" })).toBeNull();
      expect(hook("run_command", { command: "curl example.com" })).toBeNull();
    });
  });

  describe("SSRF protection — private IP blocking", () => {
    const privateIPs = [
      { ip: "10.0.0.1", desc: "10.x.x.x" },
      { ip: "10.255.255.255", desc: "10.x.x.x upper" },
      { ip: "172.16.0.1", desc: "172.16.x.x" },
      { ip: "172.31.255.255", desc: "172.31.x.x" },
      { ip: "192.168.1.1", desc: "192.168.x.x" },
      { ip: "192.168.0.100", desc: "192.168.0.x" },
      { ip: "127.0.0.1", desc: "loopback" },
      { ip: "127.0.0.2", desc: "loopback alt" },
      { ip: "169.254.1.1", desc: "link-local" },
      { ip: "0.0.0.0", desc: "all interfaces" },
    ];

    for (const { ip, desc } of privateIPs) {
      it(`blocks ${desc} (${ip})`, () => {
        const result = hook("web_fetch", { url: `http://${ip}/admin` });
        expect(result).toBeTruthy();
        expect(result.deny).toBe(true);
        expect(result.reason).toContain("blocked private IP");
      });
    }

    it("blocks localhost hostname", () => {
      const result = hook("web_fetch", { url: "http://localhost/api" });
      expect(result).toBeTruthy();
      expect(result.deny).toBe(true);
    });

    it("blocks IPv6 loopback [::1]", () => {
      const result = hook("web_fetch", { url: "http://[::1]/api" });
      expect(result).toBeTruthy();
      expect(result.deny).toBe(true);
    });

    it("allows public IPs", () => {
      const result = hook("web_fetch", { url: "https://8.8.8.8/dns" });
      expect(result).toBeNull();
    });

    it("allows public domains", () => {
      const result = hook("web_fetch", { url: "https://example.com/page" });
      expect(result).toBeNull();
    });
  });

  describe("agent port exclusion", () => {
    it("allows localhost requests to agent's own port", () => {
      const hookWithPort = createNetworkGuardHook(policy, 3000);
      const result = hookWithPort("web_fetch", {
        url: "http://localhost:3000/status",
      });
      expect(result).toBeNull();
    });

    it("blocks localhost requests to other ports", () => {
      const hookWithPort = createNetworkGuardHook(policy, 3000);
      const result = hookWithPort("web_fetch", {
        url: "http://localhost:4000/admin",
      });
      expect(result).toBeTruthy();
      expect(result.deny).toBe(true);
    });
  });

  describe("protocol blocking", () => {
    it("blocks file:// protocol", () => {
      const result = hook("web_fetch", { url: "file:///etc/passwd" });
      expect(result).toBeTruthy();
      expect(result.deny).toBe(true);
      expect(result.reason).toContain("blocked protocol");
    });

    it("blocks ftp:// protocol", () => {
      const result = hook("web_fetch", { url: "ftp://example.com/file" });
      expect(result).toBeTruthy();
      expect(result.deny).toBe(true);
    });

    it("allows http://", () => {
      const result = hook("web_fetch", { url: "http://example.com" });
      expect(result).toBeNull();
    });

    it("allows https://", () => {
      const result = hook("web_fetch", { url: "https://example.com" });
      expect(result).toBeNull();
    });
  });

  describe("invalid URLs", () => {
    it("blocks invalid URLs", () => {
      const result = hook("web_fetch", { url: "not-a-url" });
      expect(result).toBeTruthy();
      expect(result.deny).toBe(true);
      expect(result.reason).toContain("invalid URL");
    });
  });

  describe("rate limiting", () => {
    it("allows requests within rate limit", () => {
      // Normal policy: 60 per minute
      for (let i = 0; i < 10; i++) {
        const result = hook("web_fetch", {
          url: "https://example.com/page" + i,
        });
        expect(result).toBeNull();
      }
    });

    it("blocks requests exceeding rate limit", () => {
      // Create a strict policy with low rate limit
      const strictPolicy = loadPolicy({ securityPolicy: "strict" });
      const strictHook = createNetworkGuardHook(strictPolicy);

      // Exhaust rate limit (30 per minute for strict)
      for (let i = 0; i < 30; i++) {
        strictHook("web_fetch", { url: "https://example.com/" + i });
      }

      // Next request should be rate limited
      const result = strictHook("web_fetch", {
        url: "https://example.com/blocked",
      });
      expect(result).toBeTruthy();
      expect(result.deny).toBe(true);
      expect(result.reason).toContain("rate limited");
    });

    it("rate limits web_search", () => {
      const strictPolicy = loadPolicy({ securityPolicy: "strict" });
      const strictHook = createNetworkGuardHook(strictPolicy);

      // Exhaust rate limit
      for (let i = 0; i < 30; i++) {
        strictHook("web_search", { query: "test " + i });
      }

      const result = strictHook("web_search", { query: "blocked" });
      expect(result).toBeTruthy();
      expect(result.deny).toBe(true);
      expect(result.reason).toContain("rate limited");
    });
  });

  describe("permissive policy", () => {
    it("allows private IPs when blockPrivateIPs is false", () => {
      const permissivePolicy = loadPolicy({ securityPolicy: "permissive" });
      const permissiveHook = createNetworkGuardHook(permissivePolicy);
      const result = permissiveHook("web_fetch", {
        url: "http://192.168.1.1/admin",
      });
      expect(result).toBeNull();
    });
  });

  describe("edge cases", () => {
    it("returns null for missing url", () => {
      expect(hook("web_fetch", {})).toBeNull();
    });

    it("returns null for non-string url", () => {
      expect(hook("web_fetch", { url: 42 })).toBeNull();
    });

    it("does not block 172.15.x.x (not in private range)", () => {
      const result = hook("web_fetch", {
        url: "http://172.15.0.1/test",
      });
      expect(result).toBeNull();
    });

    it("does not block 172.32.x.x (not in private range)", () => {
      const result = hook("web_fetch", {
        url: "http://172.32.0.1/test",
      });
      expect(result).toBeNull();
    });
  });
});
