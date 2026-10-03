import { describe, it, expect } from "vitest";
import {
  detectByMagicBytes,
  isLikelyText,
  detectBase64Content,
  validateContentType,
} from "../../../src/security/content-validator.js";

describe("Content Validator", () => {
  describe("detectByMagicBytes", () => {
    it("detects PNG", () => {
      const png = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
      expect(detectByMagicBytes(png)).toEqual({ type: "image", subtype: "png" });
    });

    it("detects JPEG", () => {
      const jpg = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10]);
      expect(detectByMagicBytes(jpg)).toEqual({ type: "image", subtype: "jpeg" });
    });

    it("detects GIF", () => {
      const gif = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
      expect(detectByMagicBytes(gif)).toEqual({ type: "image", subtype: "gif" });
    });

    it("detects PDF", () => {
      const pdf = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2D]);
      expect(detectByMagicBytes(pdf)).toEqual({ type: "document", subtype: "pdf" });
    });

    it("detects Windows PE executable", () => {
      const exe = Buffer.from([0x4D, 0x5A, 0x90, 0x00]);
      expect(detectByMagicBytes(exe)).toEqual({ type: "executable", subtype: "pe" });
    });

    it("detects ELF executable", () => {
      const elf = Buffer.from([0x7F, 0x45, 0x4C, 0x46, 0x02]);
      expect(detectByMagicBytes(elf)).toEqual({ type: "executable", subtype: "elf" });
    });

    it("detects ZIP archive", () => {
      const zip = Buffer.from([0x50, 0x4B, 0x03, 0x04, 0x14, 0x00]);
      expect(detectByMagicBytes(zip)).toEqual({ type: "archive", subtype: "zip" });
    });

    it("detects MP3 with ID3", () => {
      const mp3 = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00]);
      expect(detectByMagicBytes(mp3)).toEqual({ type: "audio", subtype: "mp3-id3" });
    });

    it("detects MP4 video (ftyp at offset 4)", () => {
      const mp4 = Buffer.from([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6F, 0x6D]);
      expect(detectByMagicBytes(mp4)).toEqual({ type: "video", subtype: "mp4" });
    });

    it("detects WEBP via RIFF container", () => {
      // RIFF + size + WEBP
      const webp = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);
      expect(detectByMagicBytes(webp)).toEqual({ type: "image", subtype: "webp" });
    });

    it("detects WAV via RIFF container", () => {
      const wav = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45]);
      expect(detectByMagicBytes(wav)).toEqual({ type: "audio", subtype: "wav" });
    });

    it("detects SQLite database", () => {
      const sqlite = Buffer.from("SQLite format 3\0", "ascii");
      expect(detectByMagicBytes(sqlite)).toEqual({ type: "database", subtype: "sqlite" });
    });

    it("detects WebAssembly", () => {
      const wasm = Buffer.from([0x00, 0x61, 0x73, 0x6D, 0x01, 0x00, 0x00, 0x00]);
      expect(detectByMagicBytes(wasm)).toEqual({ type: "executable", subtype: "wasm" });
    });

    it("detects Java class file", () => {
      const cls = Buffer.from([0xCA, 0xFE, 0xBA, 0xBE, 0x00, 0x00, 0x00, 0x3D]);
      expect(detectByMagicBytes(cls)).toEqual({ type: "executable", subtype: "java-class" });
    });

    it("returns null for plain text", () => {
      const text = Buffer.from("hello world, just text");
      expect(detectByMagicBytes(text)).toBeNull();
    });

    it("returns null for empty input", () => {
      expect(detectByMagicBytes(Buffer.alloc(0))).toBeNull();
      expect(detectByMagicBytes(null)).toBeNull();
    });
  });

  describe("isLikelyText", () => {
    it("returns true for plain text", () => {
      expect(isLikelyText(Buffer.from("Hello world\nLine 2"))).toBe(true);
    });

    it("returns true for empty buffer", () => {
      expect(isLikelyText(Buffer.alloc(0))).toBe(true);
    });

    it("returns false for buffer with many null bytes", () => {
      const binary = Buffer.alloc(1000, 0); // all nulls
      expect(isLikelyText(binary)).toBe(false);
    });

    it("returns true for text with rare nulls", () => {
      // 1 null in 200+ chars is well under 1%
      const text = "a".repeat(200) + "\0" + "b".repeat(200);
      expect(isLikelyText(Buffer.from(text))).toBe(true);
    });
  });

  describe("detectBase64Content", () => {
    it("detects binary content in base64 PNG", () => {
      const png = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D]);
      const b64 = png.toString("base64");
      const result = detectBase64Content(b64);
      expect(result.isBinary).toBe(true);
      expect(result.detected.type).toBe("image");
      expect(result.detected.subtype).toBe("png");
    });

    it("returns not binary for base64 text", () => {
      const b64 = Buffer.from("just regular text content").toString("base64");
      const result = detectBase64Content(b64);
      expect(result.isBinary).toBe(false);
    });

    it("handles null/undefined", () => {
      expect(detectBase64Content(null).isBinary).toBe(false);
      expect(detectBase64Content(undefined).isBinary).toBe(false);
    });
  });

  describe("validateContentType", () => {
    it("flags executable disguised as image", () => {
      const exe = Buffer.from([0x4D, 0x5A, 0x90, 0x00, 0x03, 0x00]);
      const result = validateContentType("image/png", exe);
      expect(result.valid).toBe(false);
      expect(result.mismatch).toBe(true);
      expect(result.actual.type).toBe("executable");
    });

    it("allows correctly typed executable", () => {
      const exe = Buffer.from([0x4D, 0x5A, 0x90, 0x00]);
      const result = validateContentType("application/octet-stream", exe);
      expect(result.valid).toBe(true);
    });

    it("allows plain text with no magic bytes", () => {
      const text = Buffer.from("normal text content");
      const result = validateContentType("text/plain", text);
      expect(result.valid).toBe(true);
      expect(result.mismatch).toBe(false);
    });

    it("allows correctly typed PNG", () => {
      const png = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
      const result = validateContentType("image/png", png);
      expect(result.valid).toBe(true);
    });
  });
});
