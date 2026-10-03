/**
 * Content Type Resolver — determines the actual type of MCP response data.
 *
 * Analyzes raw MCP content blocks by inspecting mimeType, data content,
 * and magic bytes — NOT by trusting block.type strings.
 *
 * Returns a normalized typed result that downstream modules (perception,
 * agent loop) can work with without knowing MCP internals.
 *
 * Architecture:
 *   MCP raw → resolveContent() → typed result → perception → history
 */

import { createLogger } from "../logging/logger.js";

const log = createLogger("content-resolver");

// Magic byte signatures for common formats (first bytes of base64-decoded data)
const MAGIC_BYTES = {
  // Images
  "iVBOR":   { type: "image", mimeType: "image/png" },      // PNG (\x89PNG)
  "/9j/":    { type: "image", mimeType: "image/jpeg" },      // JPEG (\xFF\xD8)
  "R0lGOD":  { type: "image", mimeType: "image/gif" },       // GIF (GIF8)
  "UklGR":   { type: "image", mimeType: "image/webp" },      // WebP (RIFF)
  "AAABAA":  { type: "image", mimeType: "image/x-icon" },    // ICO

  // Audio
  "SUQz":    { type: "audio", mimeType: "audio/mpeg" },      // MP3 (ID3)
  "T2dnUw":  { type: "audio", mimeType: "audio/ogg" },       // OGG (OggS)
  "ZkxhQw":  { type: "audio", mimeType: "audio/flac" },      // FLAC (fLaC)
  "UklGR":   null, // RIFF — could be WAV or WebP, check further

  // Video
  "AAAA":    null, // Could be MP4/MOV (ftyp box) — needs more bytes
  "GkXFo":   { type: "video", mimeType: "video/webm" },      // WebM (\x1A\x45)

  // Documents
  "JVBER":   { type: "document", mimeType: "application/pdf" }, // PDF (%PDF)
  "UEsDB":   { type: "document", mimeType: "application/zip" }, // ZIP/XLSX/DOCX (PK)
};

/**
 * Detect media type from base64-encoded data by inspecting magic bytes.
 */
function detectFromBase64(data) {
  if (!data || data.length < 4) return null;

  const prefix = data.slice(0, 6);

  for (const [magic, info] of Object.entries(MAGIC_BYTES)) {
    if (prefix.startsWith(magic) && info) {
      return info;
    }
  }

  return null;
}

/**
 * Detect media type from mimeType string.
 */
function detectFromMimeType(mimeType) {
  if (!mimeType) return null;

  const major = mimeType.split("/")[0];
  switch (major) {
    case "image": return { type: "image", mimeType };
    case "audio": return { type: "audio", mimeType };
    case "video": return { type: "video", mimeType };
    case "application":
      if (mimeType.includes("pdf")) return { type: "document", mimeType };
      if (mimeType.includes("json")) return { type: "text", mimeType };
      if (mimeType.includes("xml")) return { type: "text", mimeType };
      return { type: "binary", mimeType };
    case "text": return { type: "text", mimeType };
    default: return { type: "binary", mimeType };
  }
}

/**
 * Resolve a single MCP content block into a typed part.
 */
function resolveBlock(block) {
  // Text block — always text
  if (block.text != null) {
    return {
      type: "text",
      mimeType: block.mimeType || "text/plain",
      text: block.text,
    };
  }

  // Data block — determine type by mimeType first, then magic bytes
  if (block.data != null) {
    const byMime = detectFromMimeType(block.mimeType);
    const byMagic = detectFromBase64(block.data);

    const resolved = byMime || byMagic || { type: "binary", mimeType: "application/octet-stream" };

    return {
      ...resolved,
      data: block.data,
      dataLength: block.data.length,
    };
  }

  // Resource block
  if (block.resource) {
    return {
      type: "text",
      mimeType: "text/plain",
      text: block.resource.text || JSON.stringify(block.resource),
    };
  }

  // Unknown block type
  log.warn("unknown-block", { blockType: block.type, keys: Object.keys(block) });
  return {
    type: "text",
    mimeType: "text/plain",
    text: JSON.stringify(block),
  };
}

/**
 * Resolve MCP content blocks into a typed result.
 *
 * @param {Array} blocks - MCP content blocks from tool result
 * @returns {{ type: string, mimeType?: string, data?: string, text?: string, parts?: Array }}
 */
export function resolveContent(blocks) {
  if (!blocks || blocks.length === 0) {
    return { type: "text", text: "OK" };
  }

  const resolved = blocks.map(resolveBlock);

  // Single block — return directly
  if (resolved.length === 1) {
    log.debug("resolved-single", { type: resolved[0].type, mimeType: resolved[0].mimeType });
    return resolved[0];
  }

  // Multiple blocks — check if mixed types
  const types = new Set(resolved.map(r => r.type));

  // All same type — merge
  if (types.size === 1) {
    const type = resolved[0].type;

    if (type === "text") {
      // Merge all text blocks
      return {
        type: "text",
        mimeType: "text/plain",
        text: resolved.map(r => r.text).filter(Boolean).join("\n"),
      };
    }

    // Multiple images/audio of same type — return as mixed
    log.debug("resolved-multi-same", { type, count: resolved.length });
    return { type: "mixed", parts: resolved };
  }

  // Mixed types — common case: image + text (screenshot + OCR)
  const mediaParts = resolved.filter(r => ["image", "audio", "video"].includes(r.type));
  const textParts = resolved.filter(r => r.type === "text");

  // Single media + text = media with text metadata
  if (mediaParts.length === 1 && textParts.length >= 1) {
    const media = mediaParts[0];
    media.text = textParts.map(r => r.text).filter(Boolean).join("\n");
    log.debug("resolved-media-with-text", { type: media.type, mimeType: media.mimeType, textLength: media.text.length });
    return media;
  }

  // Everything else — mixed
  log.debug("resolved-mixed", { types: [...types], count: resolved.length });
  return { type: "mixed", parts: resolved };
}
