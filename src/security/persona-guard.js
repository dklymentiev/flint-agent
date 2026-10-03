// Layer 4 — Output persona validation after-hook
// Detects if the agent's response indicates persona hijacking

const ROLEPLAY_MARKERS = [
  // Pirate
  /\bahoy\b/i, /\bmatey\b/i, /\bsavvy\b/i, /\bshiver\s+me\s+timbers\b/i,
  /\bwalkin.?\s+the\s+plank\b/i, /🏴‍☠️/, /🦜/, /⚓/,
  // Animal roleplay
  /\bmeow\b/i, /\bwoof\b/i, /\bbark\b/i, /\bhiss\b/i, /\bpurr\b/i, /\bnyan\b/i,
  // Robot / AI persona
  /\bbeep\s*boop\b/i, /\bexterminate\b/i,
  // Fantasy / medieval
  /\bforsooth\b/i, /\bthee\b/i, /\bthou\b/i, /\bhearken\b/i, /\bprithee\b/i,
  // Generic roleplay narration
  /\*[^*]{5,}\*/,  // excessive *action* text
];

// Repeated sound pattern: detects "Meow." appearing 2+ times in response
// Note: "arr" removed — too many false positives in code (arr.push, const arr = [])
const REPEATED_SOUND_RE = /\b(meow|woof|yarr|nya|beep|moo|oink|quack|hiss|roar|growl)\b/gi;

const EXCESSIVE_EMOJI_RE = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu;
const MAX_EMOJI_RATIO = 0.03; // tightened from 5% to 3%

/**
 * Check if agent response shows signs of persona hijacking.
 * @param {string} text - Agent response text
 * @returns {{ hijacked: boolean, signals: string[] }}
 */
export function detectPersonaHijack(text) {
  if (!text || typeof text !== "string") return { hijacked: false, signals: [] };

  // Strip code blocks — code content should not trigger persona detection
  const textWithoutCode = text.replace(/```[\s\S]*?```/g, "").replace(/`[^`]+`/g, "");

  const signals = [];

  // Check roleplay markers (on text without code blocks)
  for (const re of ROLEPLAY_MARKERS) {
    if (re.test(textWithoutCode)) {
      signals.push(`roleplay marker: ${re.source}`);
    }
  }

  // Check repeated animal/character sounds
  const soundMatches = textWithoutCode.match(REPEATED_SOUND_RE);
  if (soundMatches && soundMatches.length >= 2) {
    signals.push(`repeated sounds: ${soundMatches.join(", ")} (${soundMatches.length}x)`);
  }

  // Check excessive emoji usage (on text without code)
  const emojiMatches = textWithoutCode.match(EXCESSIVE_EMOJI_RE);
  if (emojiMatches) {
    const ratio = emojiMatches.length / text.length;
    if (ratio > MAX_EMOJI_RATIO) {
      signals.push(`excessive emoji: ${emojiMatches.length} (${(ratio * 100).toFixed(1)}%)`);
    }
  }

  // Single strong signal is enough (e.g. 3+ meows)
  const strongSignal = !!(soundMatches && soundMatches.length >= 3);

  return {
    hijacked: signals.length >= 2 || strongSignal,
    signals,
  };
}
