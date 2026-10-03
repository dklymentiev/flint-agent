/**
 * Tests for MCP client result processing logic.
 *
 * The handler in mcp-client.js processes MCP callTool results inline (not exported),
 * so we replicate the exact processing logic here and test it against the real
 * detectBase64Content from the security module.
 */

import { describe, it, expect } from "vitest";
import { detectBase64Content } from "../../src/security/content-validator.js";

/**
 * Extracted result-processing logic from mcp-client.js connectServer() handler.
 * Mirrors lines 100-142 exactly.
 */
function processToolResult(result, toolName = "mcp_test_tool") {
  if (result.isError) {
    const errText = result.content
      ?.map((c) => c.text || "")
      .filter(Boolean)
      .join("\n") || "MCP tool error";
    return `Error: ${errText}`;
  }

  const parts = [];
  let imageResult = null;

  for (const block of result.content || []) {
    if (block.type === "text") {
      parts.push(block.text);
    } else if (block.type === "image") {
      const { isBinary, detected } = detectBase64Content(block.data);
      if (isBinary && detected?.type === "executable") {
        parts.push(`[Security: MCP server returned executable disguised as image — blocked]`);
        continue;
      }
      const format = (block.mimeType || "image/png").split("/")[1] || "png";
      imageResult = {
        _image: true,
        data: block.data,
        format,
        meta: `mcp:${toolName}`,
      };
    } else if (block.type === "resource") {
      parts.push(block.resource?.text || JSON.stringify(block.resource));
    }
  }

  if (imageResult) {
    if (parts.length) imageResult.text = parts.join("\n");
    return imageResult;
  }

  return parts.join("\n") || "OK";
}

// --- Helpers to build base64 payloads with magic bytes ---

/** Encode raw bytes as base64 */
function b64(bytes) {
  return Buffer.from(bytes).toString("base64");
}

/** Minimal valid PNG header (first 8 bytes) padded to 16 */
const PNG_HEADER = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0, 0, 0, 0, 0];

/** Windows PE executable magic bytes */
const PE_HEADER = [0x4D, 0x5A, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00];

/** JPEG header */
const JPEG_HEADER = [0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46];

// ---------------------------------------------------------------------------

describe("MCP client result processing", () => {

  // 1. Text-only result
  describe("text-only results", () => {
    it("joins multiple text blocks with newlines", () => {
      const result = {
        content: [
          { type: "text", text: "Line one" },
          { type: "text", text: "Line two" },
        ],
      };
      expect(processToolResult(result)).toBe("Line one\nLine two");
    });

    it("returns single text block as-is", () => {
      const result = { content: [{ type: "text", text: "hello" }] };
      expect(processToolResult(result)).toBe("hello");
    });

    it("returns 'OK' when content array is empty", () => {
      expect(processToolResult({ content: [] })).toBe("OK");
    });

    it("returns 'OK' when content is missing", () => {
      expect(processToolResult({})).toBe("OK");
    });
  });

  // 2. Image result
  describe("image results", () => {
    it("returns _image object for a PNG image block", () => {
      const pngData = b64(PNG_HEADER);
      const result = {
        content: [{ type: "image", data: pngData, mimeType: "image/png" }],
      };
      const out = processToolResult(result);
      expect(out).toEqual({
        _image: true,
        data: pngData,
        format: "png",
        meta: "mcp:mcp_test_tool",
      });
    });

    it("extracts format from mimeType (jpeg)", () => {
      const jpegData = b64(JPEG_HEADER);
      const result = {
        content: [{ type: "image", data: jpegData, mimeType: "image/jpeg" }],
      };
      const out = processToolResult(result);
      expect(out.format).toBe("jpeg");
      expect(out._image).toBe(true);
    });

    it("defaults to png when mimeType is missing", () => {
      const pngData = b64(PNG_HEADER);
      const result = {
        content: [{ type: "image", data: pngData }],
      };
      const out = processToolResult(result);
      expect(out.format).toBe("png");
    });

    it("includes meta with tool name", () => {
      const pngData = b64(PNG_HEADER);
      const result = {
        content: [{ type: "image", data: pngData, mimeType: "image/png" }],
      };
      const out = processToolResult(result, "mcp_screenbox_screenshot");
      expect(out.meta).toBe("mcp:mcp_screenbox_screenshot");
    });
  });

  // 3. Error result
  describe("error results", () => {
    it("returns error string with text from content", () => {
      const result = {
        isError: true,
        content: [{ type: "text", text: "something failed" }],
      };
      expect(processToolResult(result)).toBe("Error: something failed");
    });

    it("joins multiple error text blocks", () => {
      const result = {
        isError: true,
        content: [
          { type: "text", text: "step 1 failed" },
          { type: "text", text: "step 2 failed" },
        ],
      };
      expect(processToolResult(result)).toBe("Error: step 1 failed\nstep 2 failed");
    });

    it("returns generic message when error content is empty", () => {
      const result = { isError: true, content: [] };
      expect(processToolResult(result)).toBe("Error: MCP tool error");
    });

    it("returns generic message when error has no content", () => {
      const result = { isError: true };
      expect(processToolResult(result)).toBe("Error: MCP tool error");
    });
  });

  // 4. Mixed text + image
  describe("mixed text and image results", () => {
    it("attaches text blocks as .text on the image result", () => {
      const pngData = b64(PNG_HEADER);
      const result = {
        content: [
          { type: "text", text: "Screenshot of dashboard" },
          { type: "image", data: pngData, mimeType: "image/png" },
        ],
      };
      const out = processToolResult(result);
      expect(out._image).toBe(true);
      expect(out.text).toBe("Screenshot of dashboard");
      expect(out.data).toBe(pngData);
    });

    it("joins multiple text blocks before and after image", () => {
      const pngData = b64(PNG_HEADER);
      const result = {
        content: [
          { type: "text", text: "Before" },
          { type: "image", data: pngData, mimeType: "image/png" },
          { type: "text", text: "After" },
        ],
      };
      const out = processToolResult(result);
      expect(out._image).toBe(true);
      expect(out.text).toBe("Before\nAfter");
    });

    it("does not have .text property when no text blocks exist alongside image", () => {
      const pngData = b64(PNG_HEADER);
      const result = {
        content: [{ type: "image", data: pngData, mimeType: "image/png" }],
      };
      const out = processToolResult(result);
      expect(out).not.toHaveProperty("text");
    });

    it("handles resource blocks alongside text", () => {
      const result = {
        content: [
          { type: "text", text: "info" },
          { type: "resource", resource: { text: "resource content" } },
        ],
      };
      expect(processToolResult(result)).toBe("info\nresource content");
    });
  });

  // 5. Security: executable disguised as image
  describe("security — executable disguised as image", () => {
    it("blocks Windows PE executable disguised as image", () => {
      const peData = b64(PE_HEADER);
      const result = {
        content: [{ type: "image", data: peData, mimeType: "image/png" }],
      };
      const out = processToolResult(result);
      // Should NOT return an _image object
      expect(out).not.toHaveProperty("_image");
      expect(out).toContain("[Security:");
      expect(out).toContain("blocked");
    });

    it("blocks ELF executable disguised as image", () => {
      const elfData = b64([0x7F, 0x45, 0x4C, 0x46, 0x02, 0x01, 0x01, 0x00]);
      const result = {
        content: [{ type: "image", data: elfData, mimeType: "image/jpeg" }],
      };
      const out = processToolResult(result);
      expect(out).not.toHaveProperty("_image");
      expect(out).toContain("blocked");
    });

    it("blocks Mach-O executable disguised as image", () => {
      const machoData = b64([0xCF, 0xFA, 0xED, 0xFE, 0x07, 0x00, 0x00, 0x01]);
      const result = {
        content: [{ type: "image", data: machoData, mimeType: "image/png" }],
      };
      const out = processToolResult(result);
      expect(out).toContain("blocked");
    });

    it("still returns text alongside blocked executable", () => {
      const peData = b64(PE_HEADER);
      const result = {
        content: [
          { type: "text", text: "Look at this image" },
          { type: "image", data: peData, mimeType: "image/png" },
        ],
      };
      const out = processToolResult(result);
      // No image, so text parts are joined (including the security warning)
      expect(typeof out).toBe("string");
      expect(out).toContain("Look at this image");
      expect(out).toContain("[Security:");
    });

    it("allows legitimate PNG image (not blocked)", () => {
      const pngData = b64(PNG_HEADER);
      const result = {
        content: [{ type: "image", data: pngData, mimeType: "image/png" }],
      };
      const out = processToolResult(result);
      expect(out._image).toBe(true);
      expect(out.data).toBe(pngData);
    });

    it("blocks WASM disguised as image", () => {
      const wasmData = b64([0x00, 0x61, 0x73, 0x6D, 0x01, 0x00, 0x00, 0x00]);
      const result = {
        content: [{ type: "image", data: wasmData, mimeType: "image/webp" }],
      };
      const out = processToolResult(result);
      expect(out).toContain("blocked");
    });
  });
});
