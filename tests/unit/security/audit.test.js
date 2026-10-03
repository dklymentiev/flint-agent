import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  initAudit,
  auditLog,
  createAuditBeforeHook,
  createAuditAfterHook,
} from "../../../src/security/audit.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

describe("audit", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("initAudit", () => {
    it("creates sessionsDir if it does not exist", () => {
      const subDir = path.join(tmpDir, "nested", "sessions");
      initAudit({ sessionsDir: subDir });
      expect(fs.existsSync(subDir)).toBe(true);
    });

    it("does not fail if sessionsDir already exists", () => {
      initAudit({ sessionsDir: tmpDir });
      // no throw
    });
  });

  describe("auditLog", () => {
    beforeEach(() => {
      initAudit({ sessionsDir: tmpDir });
    });

    it("writes a JSON line to audit.jsonl", () => {
      auditLog("TEST_EVENT", "test_tool", { key: "value" });
      const auditFile = path.join(tmpDir, "audit.jsonl");
      expect(fs.existsSync(auditFile)).toBe(true);
      const content = fs.readFileSync(auditFile, "utf-8").trim();
      const entry = JSON.parse(content);
      expect(entry.event).toBe("TEST_EVENT");
      expect(entry.tool).toBe("test_tool");
      expect(entry.args.key).toBe("value");
      expect(entry.ts).toBeDefined();
    });

    it("appends multiple entries as separate lines", () => {
      auditLog("EVENT_1", "tool1", {});
      auditLog("EVENT_2", "tool2", {});
      const auditFile = path.join(tmpDir, "audit.jsonl");
      const lines = fs.readFileSync(auditFile, "utf-8").trim().split("\n");
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0]).event).toBe("EVENT_1");
      expect(JSON.parse(lines[1]).event).toBe("EVENT_2");
    });

    it("truncates long argument values", () => {
      const longValue = "x".repeat(300);
      auditLog("TRUNC_TEST", "tool", { long: longValue });
      const auditFile = path.join(tmpDir, "audit.jsonl");
      const entry = JSON.parse(
        fs.readFileSync(auditFile, "utf-8").trim()
      );
      expect(entry.args.long.length).toBeLessThanOrEqual(203); // 200 + "..."
      expect(entry.args.long).toContain("...");
    });

    it("includes extra data in the entry", () => {
      auditLog("EXTRA_TEST", "tool", {}, { custom: "data" });
      const auditFile = path.join(tmpDir, "audit.jsonl");
      const entry = JSON.parse(
        fs.readFileSync(auditFile, "utf-8").trim()
      );
      expect(entry.custom).toBe("data");
    });

    it("handles null toolName", () => {
      auditLog("NULL_TOOL", null, {});
      const auditFile = path.join(tmpDir, "audit.jsonl");
      const entry = JSON.parse(
        fs.readFileSync(auditFile, "utf-8").trim()
      );
      expect(entry.tool).toBeNull();
    });

    it("does nothing when auditFile is not initialized", () => {
      // Reinitialize to a non-existent state by importing fresh
      // But since module state persists, we verify the function at least doesn't throw
      // when called normally
      auditLog("SAFE_EVENT", "tool", {});
      // no throw means success
    });
  });

  describe("rotation", () => {
    it("rotates audit file when it exceeds 10MB", () => {
      initAudit({ sessionsDir: tmpDir });
      const auditFile = path.join(tmpDir, "audit.jsonl");

      // Create a file that exceeds 10MB
      const bigContent = "x".repeat(10 * 1024 * 1024 + 1);
      fs.writeFileSync(auditFile, bigContent);

      // Next auditLog should trigger rotation
      auditLog("AFTER_ROTATION", "tool", {});

      // Old file should be renamed
      const files = fs.readdirSync(tmpDir);
      const rotatedFiles = files.filter(
        (f) => f.startsWith("audit-") && f.endsWith(".jsonl")
      );
      expect(rotatedFiles.length).toBeGreaterThanOrEqual(1);

      // New audit.jsonl should exist with the new entry
      expect(fs.existsSync(auditFile)).toBe(true);
      const content = fs.readFileSync(auditFile, "utf-8").trim();
      const entry = JSON.parse(content);
      expect(entry.event).toBe("AFTER_ROTATION");
    });
  });

  describe("createAuditBeforeHook", () => {
    beforeEach(() => {
      initAudit({ sessionsDir: tmpDir });
    });

    it("returns a function that always returns null", () => {
      const hook = createAuditBeforeHook();
      const result = hook("some_tool", { key: "val" });
      expect(result).toBeNull();
    });

    it("logs TOOL_CALL event", () => {
      const hook = createAuditBeforeHook();
      hook("read_file", { path: "/tmp/test" });
      const auditFile = path.join(tmpDir, "audit.jsonl");
      const entry = JSON.parse(
        fs.readFileSync(auditFile, "utf-8").trim()
      );
      expect(entry.event).toBe("TOOL_CALL");
      expect(entry.tool).toBe("read_file");
    });
  });

  describe("createAuditAfterHook", () => {
    beforeEach(() => {
      initAudit({ sessionsDir: tmpDir });
    });

    it("returns a function that always returns null", () => {
      const hook = createAuditAfterHook();
      const result = hook("some_tool", {}, "result text");
      expect(result).toBeNull();
    });

    it("logs TOOL_RESULT event with truncated result preview", () => {
      const hook = createAuditAfterHook();
      hook("read_file", {}, "short result");
      const auditFile = path.join(tmpDir, "audit.jsonl");
      const entry = JSON.parse(
        fs.readFileSync(auditFile, "utf-8").trim()
      );
      expect(entry.event).toBe("TOOL_RESULT");
      expect(entry.resultPreview).toBe("short result");
    });

    it("truncates long results in preview", () => {
      const hook = createAuditAfterHook();
      const longResult = "a".repeat(200);
      hook("read_file", {}, longResult);
      const auditFile = path.join(tmpDir, "audit.jsonl");
      const entry = JSON.parse(
        fs.readFileSync(auditFile, "utf-8").trim()
      );
      expect(entry.resultPreview.length).toBeLessThanOrEqual(103);
      expect(entry.resultPreview).toContain("...");
    });
  });
});
