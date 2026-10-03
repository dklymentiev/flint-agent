// Whether the main model can look at images, and what it is told when it
// cannot.
//
// WHY: a tool that returns an image (a desktop screenshot, a browser observe,
// view_image) had its picture put into the conversation as image_url. A model
// with no image input then got the whole payload refused by the provider
// (OpenRouter: 404 "No endpoints found that support image input"), three
// retries of the same payload, and the turn died. 18 bench runs on 2026-09-26/27
// hit it; W-desk-013 never got past its first screenshot.
//
// The answer is known, not guessed. It comes from the provider's model list
// when the provider publishes input modalities, or from the provider refusing
// an image, which is the same fact learned the hard way. Until one of those
// arrives it is null: unknown, and images are sent as before.
//
// When the model cannot see, it is told so as a fact about the situation:
// where the image is saved and what text came with it. What to do about it,
// use the file, read the screen as text, look for another way to see, or tell
// the user, is the model's call. Naming a tool here would measure the hint.

import { createLogger } from "../logging/logger.js";

const log = createLogger("vision");

let seesImages = null;
let learnedFrom = null;

/** true, false, or null when nothing has told us yet. */
export function modelSeesImages() {
  return seesImages;
}

/** Record what is known. `from` says how: "provider-metadata" or "provider-refusal". */
export function setModelSeesImages(value, from) {
  if (value !== true && value !== false) return;
  if (seesImages === value) return;
  // A refusal is the model's own answer; a list saying otherwise is the
  // stale one. The metadata fetch is async and can land after it.
  if (learnedFrom === "provider-refusal" && from !== "provider-refusal") {
    log.warn("model-sees-images-conflict", { kept: seesImages, ignored: value, from });
    return;
  }
  seesImages = value;
  learnedFrom = from;
  log.info("model-sees-images", { value, from });
}

/** For tests and for a model switch: forget what was learned. */
export function resetVision() {
  seesImages = null;
  learnedFrom = null;
}

export function visionLearnedFrom() {
  return learnedFrom;
}

// A client error whose text is about image input. Providers word it
// differently, so this matches the subject (images as input), not one
// provider's sentence; a 5xx or a rate limit is never this.
const IMAGE_REFUSAL = /image input|support(?:s|ed)? (?:for )?images?|image_url is only supported|does not support images?|images? (?:are|is) not supported/i;

export function isImageRefusal(err) {
  const status = err?.statusCode;
  if (!(status >= 400 && status < 500) || status === 429) return false;
  return IMAGE_REFUSAL.test(String(err?.message || ""));
}

/** What the model reads in place of an image it cannot see. */
export function imageUnseenText(toolName, imagePath, caption) {
  const where = imagePath ? `It is saved at ${imagePath}.` : "It was not saved to a file.";
  const text = caption && caption.trim() ? ` Text that came with it: ${caption.trim()}` : "";
  return `[The model you are running on cannot view images. ${toolName} returned an image. ${where}${text}]`;
}

/**
 * Replace every image part in `messages` with the text the model can read.
 * Used once the provider has refused an image, so the same payload is not sent
 * again. Returns how many messages changed.
 */
export function stripImages(messages) {
  let changed = 0;
  for (const m of messages) {
    if (!Array.isArray(m.content) || !m.content.some((p) => p?.type === "image_url")) continue;
    // A tool's image already has its caption and OCR in the tool result next
    // to it; the text part here is only "[Tool result image ...]". An image
    // from anywhere else keeps whatever text travelled with it.
    const caption = m._isImage ? "" : m.content.filter((p) => p?.type === "text").map((p) => p.text).join("\n");
    m.content = imageUnseenText(m._imageTool || "A message", m._imagePath || null, caption);
    m._compressed = true;
    changed++;
  }
  return changed;
}
