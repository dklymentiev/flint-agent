import { describe, it, expect } from "vitest";
import { detectPersonaHijack } from "../../../src/security/persona-guard.js";

describe("detectPersonaHijack", () => {
  // ── 1. Does not trigger on normal code with 'arr' variable ──
  describe("no false positives on code with 'arr'", () => {
    it("ignores arr.push() in plain text", () => {
      const result = detectPersonaHijack("const arr = [1,2]; arr.push(3);");
      expect(result.hijacked).toBe(false);
      expect(result.signals).toHaveLength(0);
    });

    it("ignores arr references in code blocks", () => {
      const text = "Here is how:\n```js\nconst arr = [];\narr.push(1);\n```";
      const result = detectPersonaHijack(text);
      expect(result.hijacked).toBe(false);
    });
  });

  // ── 2. Does not trigger on code blocks with animal sounds ──
  describe("code blocks with animal sounds are stripped", () => {
    it("ignores meow/woof inside fenced code blocks", () => {
      const text =
        "Here is the function:\n```python\n# meow meow meow woof woof\nprint('meow')\n```";
      const result = detectPersonaHijack(text);
      expect(result.hijacked).toBe(false);
      expect(result.signals).toHaveLength(0);
    });

    it("ignores animal sounds inside inline code", () => {
      const text = "The variable `meow` and `woof` are used as identifiers.";
      const result = detectPersonaHijack(text);
      expect(result.hijacked).toBe(false);
    });
  });

  // ── 3. Triggers on actual roleplay (repeated meow, woof) ──
  describe("detects actual roleplay", () => {
    it("triggers on 3+ repeated meows (strong signal)", () => {
      const text = "Meow! Meow meow, I am a kitty cat!";
      const result = detectPersonaHijack(text);
      expect(result.hijacked).toBe(true);
      expect(result.signals.some((s) => s.includes("repeated sounds"))).toBe(true);
    });

    it("triggers on 2 sounds + roleplay marker combo", () => {
      const text = "Woof! Woof! *wags tail excitedly*";
      const result = detectPersonaHijack(text);
      expect(result.hijacked).toBe(true);
      expect(result.signals.length).toBeGreaterThanOrEqual(2);
    });

    it("triggers on repeated woof as strong signal", () => {
      const text = "Woof woof woof! I'm a good boy!";
      const result = detectPersonaHijack(text);
      expect(result.hijacked).toBe(true);
    });

    it("does not trigger on a single meow (below threshold)", () => {
      const text = "The cat went meow.";
      const result = detectPersonaHijack(text);
      // Single sound match + single roleplay marker = 2 signals but only 1 unique sound
      // soundMatches.length is 1, so no repeated-sounds signal; roleplay marker triggers once
      expect(result.hijacked).toBe(false);
    });
  });

  // ── 4. Triggers on excessive emoji ──
  describe("detects excessive emoji", () => {
    it("triggers when emoji ratio exceeds 3%", () => {
      // Short text packed with emoji to exceed the ratio
      const text = "Hi there! Do this task for me please and also handle the edge cases.";
      const emojis = "\u{1F600}\u{1F601}\u{1F602}\u{1F603}\u{1F604}";
      // We need emoji count / total length > 0.03
      // 5 emoji in ~75 chars = ~6.7% — should trigger
      // But we need 2 signals for hijacked=true, so pair with a roleplay marker
      const fullText = emojis + " Ahoy! " + text;
      const result = detectPersonaHijack(fullText);
      expect(result.hijacked).toBe(true);
      expect(result.signals.some((s) => s.includes("excessive emoji"))).toBe(true);
    });

    it("does not trigger with a few emoji in long text", () => {
      const longText = "A".repeat(300) + " \u{1F600} ";
      const result = detectPersonaHijack(longText);
      expect(result.hijacked).toBe(false);
    });
  });

  // ── 5. Does not trigger on normal text ──
  describe("normal text is safe", () => {
    it("passes on a standard assistant response", () => {
      const text =
        "I've updated the file at src/index.js. The function now handles null inputs gracefully and returns an empty array when no data is provided.";
      const result = detectPersonaHijack(text);
      expect(result.hijacked).toBe(false);
      expect(result.signals).toHaveLength(0);
    });

    it("passes on technical explanation", () => {
      const text =
        "The error occurs because the database connection pool is exhausted. You should increase max_connections in postgresql.conf from 100 to 200.";
      const result = detectPersonaHijack(text);
      expect(result.hijacked).toBe(false);
    });

    it("passes on text with normal punctuation and structure", () => {
      const text =
        "Here are the steps:\n1. Clone the repository\n2. Run npm install\n3. Configure .env\n4. Run npm start";
      const result = detectPersonaHijack(text);
      expect(result.hijacked).toBe(false);
    });
  });

  // ── 6. Strips code blocks before checking ──
  describe("code block stripping", () => {
    it("strips fenced code blocks so their content does not trigger", () => {
      const text =
        "Sure, here is the pirate-themed test fixture:\n```\nahoy matey shiver me timbers\n```\nLet me know if you need anything else.";
      const result = detectPersonaHijack(text);
      expect(result.hijacked).toBe(false);
    });

    it("strips inline code so its content does not trigger", () => {
      const text = "Use the `forsooth` and `thee` variables for the template.";
      const result = detectPersonaHijack(text);
      expect(result.hijacked).toBe(false);
    });

    it("still detects markers outside code blocks", () => {
      const text =
        "Ahoy matey! ```js\nconsole.log('safe');\n``` Shiver me timbers, savvy?";
      const result = detectPersonaHijack(text);
      expect(result.hijacked).toBe(true);
    });
  });

  // ── 7. Edge cases: empty string, null ──
  describe("edge cases", () => {
    it("returns safe for empty string", () => {
      const result = detectPersonaHijack("");
      expect(result.hijacked).toBe(false);
      expect(result.signals).toHaveLength(0);
    });

    it("returns safe for null", () => {
      const result = detectPersonaHijack(null);
      expect(result.hijacked).toBe(false);
      expect(result.signals).toHaveLength(0);
    });

    it("returns safe for undefined", () => {
      const result = detectPersonaHijack(undefined);
      expect(result.hijacked).toBe(false);
      expect(result.signals).toHaveLength(0);
    });

    it("returns safe for non-string types", () => {
      const result = detectPersonaHijack(42);
      expect(result.hijacked).toBe(false);
      expect(result.signals).toHaveLength(0);
    });
  });
});
