// Content Validator — detects real content type by magic bytes
// Identifies images, audio, video, executables, archives, documents regardless of claimed type

// Magic byte signatures — [offset, bytes, type, subtype]
const SIGNATURES = [
  // Images
  [0, [0xFF, 0xD8, 0xFF], "image", "jpeg"],
  [0, [0x89, 0x50, 0x4E, 0x47], "image", "png"],
  [0, [0x47, 0x49, 0x46, 0x38], "image", "gif"],
  [0, [0x42, 0x4D], "image", "bmp"],
  [0, [0x49, 0x49, 0x2A, 0x00], "image", "tiff"],
  [0, [0x4D, 0x4D, 0x00, 0x2A], "image", "tiff"],
  [0, [0x52, 0x49, 0x46, 0x46], "container", "riff"], // WEBP, AVI, WAV
  // PDF
  [0, [0x25, 0x50, 0x44, 0x46], "document", "pdf"],
  // Executables
  [0, [0x4D, 0x5A], "executable", "pe"],          // Windows PE (.exe, .dll)
  [0, [0x7F, 0x45, 0x4C, 0x46], "executable", "elf"],  // Linux ELF
  [0, [0xCF, 0xFA, 0xED, 0xFE], "executable", "macho"], // macOS Mach-O
  [0, [0xFE, 0xED, 0xFA, 0xCE], "executable", "macho"], // macOS Mach-O (reverse)
  [0, [0xFE, 0xED, 0xFA, 0xCF], "executable", "macho64"],
  // Archives
  [0, [0x50, 0x4B, 0x03, 0x04], "archive", "zip"],     // ZIP, DOCX, XLSX, JAR
  [0, [0x1F, 0x8B], "archive", "gzip"],
  [0, [0x42, 0x5A, 0x68], "archive", "bzip2"],
  [0, [0xFD, 0x37, 0x7A, 0x58, 0x5A], "archive", "xz"],
  [0, [0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C], "archive", "7z"],
  [0, [0x52, 0x61, 0x72, 0x21, 0x1A, 0x07], "archive", "rar"],
  // Audio
  [0, [0x49, 0x44, 0x33], "audio", "mp3-id3"],          // MP3 with ID3
  [0, [0xFF, 0xFB], "audio", "mp3"],
  [0, [0xFF, 0xF3], "audio", "mp3"],
  [0, [0x66, 0x4C, 0x61, 0x43], "audio", "flac"],
  [0, [0x4F, 0x67, 0x67, 0x53], "audio", "ogg"],
  // Video
  [4, [0x66, 0x74, 0x79, 0x70], "video", "mp4"],        // MP4/MOV (ftyp at offset 4)
  [0, [0x1A, 0x45, 0xDF, 0xA3], "video", "webm"],       // WebM/MKV
  [0, [0x00, 0x00, 0x01, 0xBA], "video", "mpeg"],
  // Databases
  [0, [0x53, 0x51, 0x4C, 0x69, 0x74, 0x65], "database", "sqlite"],
  // Java
  [0, [0xCA, 0xFE, 0xBA, 0xBE], "executable", "java-class"],
  // WebAssembly
  [0, [0x00, 0x61, 0x73, 0x6D], "executable", "wasm"],
];

/**
 * Detect content type from raw bytes (Buffer or Uint8Array).
 * @param {Buffer|Uint8Array} data - Raw binary data (at least first 16 bytes)
 * @returns {{ type: string, subtype: string } | null}
 */
export function detectByMagicBytes(data) {
  if (!data || data.length < 2) return null;

  for (const [offset, bytes, type, subtype] of SIGNATURES) {
    if (data.length < offset + bytes.length) continue;
    let match = true;
    for (let i = 0; i < bytes.length; i++) {
      if (data[offset + i] !== bytes[i]) {
        match = false;
        break;
      }
    }
    if (match) {
      // RIFF container — check for WEBP/AVI/WAV
      if (subtype === "riff" && data.length >= 12) {
        const fourcc = String.fromCharCode(data[8], data[9], data[10], data[11]);
        if (fourcc === "WEBP") return { type: "image", subtype: "webp" };
        if (fourcc === "AVI ") return { type: "video", subtype: "avi" };
        if (fourcc === "WAVE") return { type: "audio", subtype: "wav" };
        return { type: "container", subtype: "riff-" + fourcc.trim() };
      }
      return { type, subtype };
    }
  }

  return null;
}

/**
 * Check if content is likely text (not binary).
 * @param {Buffer|Uint8Array} data
 * @returns {boolean}
 */
export function isLikelyText(data) {
  if (!data || !data.length) return true;
  const check = Math.min(data.length, 8192);
  let nullCount = 0;
  for (let i = 0; i < check; i++) {
    if (data[i] === 0) nullCount++;
  }
  // More than 1% null bytes → binary
  return nullCount / check < 0.01;
}

/**
 * Check if a base64 string contains binary content.
 * @param {string} b64 - Base64-encoded string
 * @returns {{ isBinary: boolean, detected: { type: string, subtype: string } | null }}
 */
export function detectBase64Content(b64) {
  if (!b64 || typeof b64 !== "string") return { isBinary: false, detected: null };
  try {
    const buf = Buffer.from(b64, "base64");
    const detected = detectByMagicBytes(buf);
    return { isBinary: detected !== null, detected };
  } catch {
    return { isBinary: false, detected: null };
  }
}

/**
 * Validate claimed type matches actual content.
 * @param {string} claimedType - MIME type or extension (e.g., "image/png", ".txt")
 * @param {Buffer|Uint8Array} data - Raw data
 * @returns {{ valid: boolean, actual: { type: string, subtype: string } | null, mismatch: boolean }}
 */
export function validateContentType(claimedType, data) {
  const actual = detectByMagicBytes(data);
  if (!actual) return { valid: true, actual: null, mismatch: false };

  const claimed = (claimedType || "").toLowerCase();

  // Check for dangerous mismatches: claimed text/image but actually executable
  if (actual.type === "executable") {
    if (!claimed.includes("executable") && !claimed.includes("application/octet")) {
      return { valid: false, actual, mismatch: true };
    }
  }

  return { valid: true, actual, mismatch: false };
}
