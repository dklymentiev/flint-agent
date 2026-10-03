import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createChildPolicyHook } from "../../../src/security/child-policy.js";
import { loadPolicy } from "../../../src/security/policies.js";

describe("child-policy", () => {
  const originalDepth = process.env.AGENT_DEPTH;

  afterEach(() => {
    if (originalDepth === undefined) {
      delete process.env.AGENT_DEPTH;
    } else {
      process.env.AGENT_DEPTH = originalDepth;
    }
  });

  describe("non-spawn tools", () => {
    it("returns null for non-spawn_agent tools", () => {
      const policy = loadPolicy({ securityPolicy: "normal" });
      const hook = createChildPolicyHook(policy);
      expect(hook("read_file", {})).toBeNull();
      expect(hook("run_command", {})).toBeNull();
    });
  });

  describe("max depth enforcement", () => {
    it("allows spawn_agent when currentDepth < maxDepth", () => {
      process.env.AGENT_DEPTH = "0";
      const policy = loadPolicy({ securityPolicy: "normal" }); // maxDepth=5
      const hook = createChildPolicyHook(policy);
      const result = hook("spawn_agent", { task: "test" });
      expect(result).toBeNull();
    });

    it("blocks spawn_agent when currentDepth >= maxDepth", () => {
      process.env.AGENT_DEPTH = "5";
      const policy = loadPolicy({ securityPolicy: "normal" }); // maxDepth=5
      const hook = createChildPolicyHook(policy);
      const result = hook("spawn_agent", { task: "test" });
      expect(result).toBeTruthy();
      expect(result.deny).toBe(true);
      expect(result.reason).toContain("max agent depth");
      expect(result.reason).toContain("5");
    });

    it("blocks spawn_agent when currentDepth exceeds maxDepth", () => {
      process.env.AGENT_DEPTH = "10";
      const policy = loadPolicy({ securityPolicy: "normal" }); // maxDepth=5
      const hook = createChildPolicyHook(policy);
      const result = hook("spawn_agent", { task: "test" });
      expect(result).toBeTruthy();
      expect(result.deny).toBe(true);
    });

    it("uses strict maxDepth=2", () => {
      process.env.AGENT_DEPTH = "2";
      const policy = loadPolicy({ securityPolicy: "strict" }); // maxDepth=2
      const hook = createChildPolicyHook(policy);
      const result = hook("spawn_agent", { task: "test" });
      expect(result).toBeTruthy();
      expect(result.deny).toBe(true);
    });

    it("allows depth 1 under strict (maxDepth=2)", () => {
      process.env.AGENT_DEPTH = "1";
      const policy = loadPolicy({ securityPolicy: "strict" });
      const hook = createChildPolicyHook(policy);
      const result = hook("spawn_agent", { task: "test" });
      expect(result).toBeNull();
    });

    it("permissive maxDepth capped to hardcoded limit", () => {
      process.env.AGENT_DEPTH = "4";
      const policy = loadPolicy({ securityPolicy: "permissive" });
      const hook = createChildPolicyHook(policy);
      // Depth 4 < hardcoded max 5 → allowed
      const result = hook("spawn_agent", { task: "test" });
      expect(result).toBeNull();
    });

    it("permissive policy cannot exceed hardcoded max depth", () => {
      process.env.AGENT_DEPTH = "5";
      const policy = loadPolicy({ securityPolicy: "permissive" });
      const hook = createChildPolicyHook(policy);
      // Depth 5 >= hardcoded max 5 → denied (permissive can't raise ceiling)
      const result = hook("spawn_agent", { task: "test" });
      expect(result).not.toBeNull();
      expect(result.deny).toBe(true);
    });
  });

  describe("AGENT_DEPTH defaults", () => {
    it("defaults to depth 0 when AGENT_DEPTH is not set", () => {
      delete process.env.AGENT_DEPTH;
      const policy = loadPolicy({ securityPolicy: "normal" });
      const hook = createChildPolicyHook(policy);
      const result = hook("spawn_agent", { task: "test" });
      expect(result).toBeNull(); // 0 < 5, so allowed
    });

    it("defaults to depth 0 when AGENT_DEPTH is non-numeric", () => {
      process.env.AGENT_DEPTH = "abc";
      const policy = loadPolicy({ securityPolicy: "normal" });
      const hook = createChildPolicyHook(policy);
      const result = hook("spawn_agent", { task: "test" });
      expect(result).toBeNull(); // defaults to 0 < 5
    });
  });
});
