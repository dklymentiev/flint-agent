import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPathGuardHook } from "../../../src/security/path-guard.js";
import { loadPolicy } from "../../../src/security/policies.js";
import os from "node:os";
import path from "node:path";

describe("path-guard", () => {
  let hook;
  let policy;
  const home = os.homedir();

  beforeEach(() => {
    policy = loadPolicy({ securityPolicy: "normal" });
    hook = createPathGuardHook(policy);
  });

  describe("non-path tools", () => {
    it("returns null for non-path tools", () => {
      expect(hook("run_command", { command: "ls" })).toBeNull();
      expect(hook("think", {})).toBeNull();
      expect(hook("web_fetch", { url: "http://example.com" })).toBeNull();
    });
  });

  describe("critical path blocking", () => {
    const criticalDirs = [".ssh", ".gnupg", ".aws"];

    for (const dir of criticalDirs) {
      it(`blocks write to ~/${dir}`, () => {
        const result = hook("write_file", { path: path.join(home, dir, "test") });
        expect(result).toBeTruthy();
        expect(result.deny).toBe(true);
        expect(result.reason).toContain("protected");
      });

      it(`requests confirm for reading ~/${dir}`, () => {
        const result = hook("read_file", { path: path.join(home, dir, "test") });
        expect(result).toBeTruthy();
        expect(result.confirm).toBe(true);
        expect(result.reason).toContain("sensitive");
      });
    }

    it("blocks writing to .permissions.json", () => {
      const result = hook("write_file", { path: ".permissions.json" });
      expect(result).toBeTruthy();
      expect(result.deny).toBe(true);
    });
  });

  describe("secret file detection", () => {
    const secretFiles = [
      ".env",
      ".env.production",
      "credentials.json",
      "server.pem",
      "server.key",
      "id_rsa",
      "id_ed25519",
      "id_ecdsa",
      ".pgpass",
      ".netrc",
    ];

    for (const file of secretFiles) {
      it(`requires confirm for ${file}`, () => {
        const result = hook("read_file", { path: `/tmp/project/${file}` });
        expect(result).toBeTruthy();
        expect(result.confirm).toBe(true);
        expect(result.reason).toContain("secrets");
      });
    }

    it("does not flag normal files", () => {
      const result = hook("read_file", { path: "/tmp/project/index.js" });
      expect(result).toBeNull();
    });
  });

  describe("args extraction", () => {
    it("checks source and destination paths for copy_file", () => {
      const result = hook("copy_file", {
        source: "/tmp/safe.txt",
        destination: path.join(home, ".ssh", "authorized_keys"),
      });
      expect(result).toBeTruthy();
      expect(result.deny).toBe(true);
    });
  });

  describe("strict policy extra deny paths", () => {
    it("blocks write to .bashrc under strict policy", () => {
      const strictPolicy = loadPolicy({ securityPolicy: "strict" });
      const strictHook = createPathGuardHook(strictPolicy);
      const result = strictHook("write_file", { path: path.join(home, ".bashrc") });
      expect(result).toBeTruthy();
      expect(result.deny).toBe(true);
    });
  });

  describe("no path args", () => {
    it("returns null when no path args provided", () => {
      const result = hook("read_file", {});
      expect(result).toBeNull();
    });
  });
});
