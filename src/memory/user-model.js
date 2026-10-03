// User Model — Layer 5 of memory architecture (dialectic).
//
// Builds a profile of the user over time by observing conversations.
// Traits: communication style, expertise level, preferences, recurring topics.
// Not explicit "user said X" (that's facts L4). This is "agent OBSERVED X".
//
// Inspired by Honcho (Plastic Labs) but implemented in own SQLite, no dependency.
// Internal task reference removed.

import { upsertTrait, getAllTraits, indexEntry } from "./sqlite-store.js";

/**
 * Observe a user message and update traits.
 * Called on each user turn. Lightweight language-neutral observations only.
 *
 * - Communication style (terse / verbose) from word count
 * - Language (ru / en / mixed) from unicode block presence
 *
 * Expertise level and role hint used to be guessed from hardcoded RU/EN keyword
 * regex (git rebase|API|CSS|...). Removed 2026-04-19 — biased to English,
 * misses Ukrainian/German/Chinese users, and is the LLM's job anyway. Those
 * traits are inferred by the LLM-based fact extractor at session end
 * (see src/memory/extract-facts.js, category "preference" / "person").
 *
 * @param {string} userMessage
 * @param {object} context — { toolsUsed, responseLanguage, sessionLength }
 */
export function observeUser(userMessage, context = {}) {
  if (!userMessage || userMessage.length < 5) return;

  // Communication style — word count is language-neutral
  const words = userMessage.split(/\s+/).length;
  if (words <= 5) {
    updateTrait("communication_style", "terse", `message: ${words} words`, 0.6);
  } else if (words > 50) {
    updateTrait("communication_style", "verbose", `message: ${words} words`, 0.6);
  }

  // Language — unicode block observation (ru / en / mixed).
  // This is observation of the user's script, not interpretation of intent.
  const hasCyrillic = /\p{Script=Cyrillic}/u.test(userMessage);
  const hasLatin = /\p{Script=Latin}/u.test(userMessage);
  const hasCjk = /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(userMessage);
  const hasArabic = /\p{Script=Arabic}/u.test(userMessage);
  let lang = null;
  if (hasCjk) lang = hasLatin ? "cjk+latin" : "cjk";
  else if (hasArabic) lang = hasLatin ? "arabic+latin" : "arabic";
  else if (hasCyrillic && !hasLatin) lang = "cyrillic";
  else if (hasLatin && !hasCyrillic) lang = "latin";
  else if (hasCyrillic && hasLatin) lang = "cyrillic+latin";
  if (lang) updateTrait("language", lang, "script observation", 0.7);
}

function updateTrait(trait, value, evidence, confidence) {
  upsertTrait(trait, value, evidence, confidence);
  indexEntry("user_model", `trait-${trait}`, `${trait}: ${value}`);
}

/**
 * Get current user profile as structured object.
 * @returns {Record<string, {value, confidence, evidence}>}
 */
export function getProfile() {
  const traits = getAllTraits();
  const profile = {};
  for (const t of traits) {
    profile[t.trait] = { value: t.value, confidence: t.confidence, evidence: t.evidence };
  }
  return profile;
}

/**
 * Format user model as system-prompt-ready block.
 * Only includes traits with confidence >= threshold.
 * @param {number} minConfidence
 * @returns {string}
 */
export function formatForPrompt(minConfidence = 0.5) {
  const traits = getAllTraits().filter(t => t.confidence >= minConfidence);
  if (!traits.length) return "";
  const lines = ["User profile (observed, adapt your behavior):"];
  for (const t of traits) {
    lines.push(`  § ${t.trait}: ${t.value} (${Math.round(t.confidence * 100)}%)`);
  }
  return lines.join("\n");
}
