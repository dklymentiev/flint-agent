import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  generatePin,
  createPairingSession,
  verifyPin,
  cleanExpiredSessions,
  isPairedToken,
  revokePairedToken,
  revokeAllPairedTokens,
  listPairedClients,
  getActiveSessions,
  _reset,
} from "../../../src/security/pairing.js";

describe("Pairing Protocol", () => {
  beforeEach(() => {
    _reset();
  });

  describe("generatePin()", () => {
    it("generates a 6-digit string", () => {
      const pin = generatePin();
      expect(pin).toHaveLength(6);
      expect(pin).toMatch(/^\d{6}$/);
    });

    it("generates different PINs", () => {
      const pins = new Set();
      for (let i = 0; i < 20; i++) {
        pins.add(generatePin());
      }
      expect(pins.size).toBeGreaterThan(1);
    });
  });

  describe("createPairingSession()", () => {
    it("creates a session with sessionId, pin, and expiresAt", () => {
      const result = createPairingSession("127.0.0.1");
      expect(result.sessionId).toBeTruthy();
      expect(result.pin).toBeTruthy();
      expect(result.pin).toHaveLength(6);
      expect(result.expiresAt).toBeGreaterThan(Date.now());
    });

    it("enforces max 5 concurrent sessions", () => {
      for (let i = 0; i < 5; i++) {
        const r = createPairingSession(`198.51.100.${i}`);
        expect(r.sessionId).toBeTruthy();
      }
      const r6 = createPairingSession("198.51.100.99");
      expect(r6.error).toBeTruthy();
      expect(r6.error).toMatch(/too many/i);
    });
  });

  describe("verifyPin()", () => {
    it("accepts correct PIN and returns token", () => {
      const session = createPairingSession("127.0.0.1");
      const result = verifyPin(session.sessionId, session.pin);
      expect(result.valid).toBe(true);
      expect(result.token).toBeTruthy();
      expect(result.token).toHaveLength(64);
    });

    it("rejects incorrect PIN", () => {
      const session = createPairingSession("127.0.0.1");
      const wrongPin = session.pin === "000000" ? "111111" : "000000";
      const result = verifyPin(session.sessionId, wrongPin);
      expect(result.valid).toBe(false);
      expect(result.error).toBeTruthy();
    });

    it("invalidates session after 3 failed attempts", () => {
      const session = createPairingSession("127.0.0.1");
      const wrongPin = session.pin === "000000" ? "111111" : "000000";

      verifyPin(session.sessionId, wrongPin);
      verifyPin(session.sessionId, wrongPin);
      const result3 = verifyPin(session.sessionId, wrongPin);

      expect(result3.valid).toBe(false);
      expect(result3.error).toMatch(/max attempts/i);

      const result4 = verifyPin(session.sessionId, session.pin);
      expect(result4.valid).toBe(false);
    });

    it("rejects invalid sessionId", () => {
      const result = verifyPin("nonexistent-id", "123456");
      expect(result.valid).toBe(false);
    });

    it("returns remaining attempts on failure", () => {
      const session = createPairingSession("127.0.0.1");
      const wrongPin = session.pin === "000000" ? "111111" : "000000";
      const r1 = verifyPin(session.sessionId, wrongPin);
      expect(r1.error).toMatch(/2 attempts remaining/);
    });
  });

  describe("isPairedToken()", () => {
    it("recognizes token from successful pairing", () => {
      const session = createPairingSession("127.0.0.1");
      const result = verifyPin(session.sessionId, session.pin);
      expect(isPairedToken(result.token)).toBe(true);
    });

    it("rejects unknown token", () => {
      expect(isPairedToken("not-a-real-token")).toBe(false);
    });
  });

  describe("getActiveSessions()", () => {
    it("counts active sessions", () => {
      expect(getActiveSessions()).toBe(0);
      createPairingSession("127.0.0.1");
      expect(getActiveSessions()).toBe(1);
      createPairingSession("127.0.0.2");
      expect(getActiveSessions()).toBe(2);
    });

    it("decreases after successful verification", () => {
      const s = createPairingSession("127.0.0.1");
      expect(getActiveSessions()).toBe(1);
      verifyPin(s.sessionId, s.pin);
      expect(getActiveSessions()).toBe(0);
    });
  });

  describe("cleanExpiredSessions()", () => {
    it("does not throw on empty state", () => {
      expect(() => cleanExpiredSessions()).not.toThrow();
    });
  });

  describe("revokePairedToken()", () => {
    it("revokes a valid token so isPairedToken returns false", () => {
      const session = createPairingSession("127.0.0.1");
      const result = verifyPin(session.sessionId, session.pin);
      expect(isPairedToken(result.token)).toBe(true);

      const deleted = revokePairedToken(result.token);
      expect(deleted).toBe(true);
      expect(isPairedToken(result.token)).toBe(false);
    });

    it("returns false for nonexistent token (graceful)", () => {
      const deleted = revokePairedToken("nonexistent-token-abc123");
      expect(deleted).toBe(false);
    });

    it("revoked token cannot be used for auth", () => {
      const s1 = createPairingSession("127.0.0.1");
      const r1 = verifyPin(s1.sessionId, s1.pin);
      const token = r1.token;

      // Token works before revocation
      expect(isPairedToken(token)).toBe(true);

      revokePairedToken(token);

      // Token fails after revocation
      expect(isPairedToken(token)).toBe(false);
    });
  });

  describe("revokeAllPairedTokens()", () => {
    it("revokes all tokens so none are valid", () => {
      // Create multiple paired tokens
      const s1 = createPairingSession("198.51.100.1");
      const s2 = createPairingSession("198.51.100.2");
      const s3 = createPairingSession("198.51.100.3");

      const t1 = verifyPin(s1.sessionId, s1.pin).token;
      const t2 = verifyPin(s2.sessionId, s2.pin).token;
      const t3 = verifyPin(s3.sessionId, s3.pin).token;

      expect(isPairedToken(t1)).toBe(true);
      expect(isPairedToken(t2)).toBe(true);
      expect(isPairedToken(t3)).toBe(true);

      revokeAllPairedTokens();

      expect(isPairedToken(t1)).toBe(false);
      expect(isPairedToken(t2)).toBe(false);
      expect(isPairedToken(t3)).toBe(false);
    });

    it("does not throw when no tokens exist", () => {
      expect(() => revokeAllPairedTokens()).not.toThrow();
    });
  });

  // A pairing is not for ever: a program paired once must not keep driving
  // Flint a month later because nobody remembered to revoke it.
  describe("pairing lifetime", () => {
    const HOUR = 60 * 60 * 1000;
    const start = new Date("2026-10-03T12:00:00Z");

    const pair = () => {
      const s = createPairingSession("127.0.0.1");
      return verifyPin(s.sessionId, s.pin, { name: "probe" }).token;
    };

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(start);
      delete process.env.FLINT_PAIRING_TTL_HOURS;
    });

    afterEach(() => {
      vi.useRealTimers();
      delete process.env.FLINT_PAIRING_TTL_HOURS;
    });

    it("accepts a token for a day by default and refuses it after", () => {
      const token = pair();
      vi.setSystemTime(start.getTime() + 23 * HOUR);
      expect(isPairedToken(token)).toBe(true);
      vi.setSystemTime(start.getTime() + 24 * HOUR + 1000);
      expect(isPairedToken(token)).toBe(false);
    });

    it("takes the lifetime from FLINT_PAIRING_TTL_HOURS", () => {
      process.env.FLINT_PAIRING_TTL_HOURS = "2";
      const token = pair();
      vi.setSystemTime(start.getTime() + 1 * HOUR);
      expect(isPairedToken(token)).toBe(true);
      vi.setSystemTime(start.getTime() + 2 * HOUR + 1000);
      expect(isPairedToken(token)).toBe(false);
    });

    it("keeps a pairing for good only when the setting is 0", () => {
      process.env.FLINT_PAIRING_TTL_HOURS = "0";
      const token = pair();
      vi.setSystemTime(start.getTime() + 24 * 365 * HOUR);
      expect(isPairedToken(token)).toBe(true);
    });

    it("falls to a day, not to no expiry, when the setting is not a number", () => {
      process.env.FLINT_PAIRING_TTL_HOURS = "forever";
      const token = pair();
      vi.setSystemTime(start.getTime() + 24 * HOUR + 1000);
      expect(isPairedToken(token)).toBe(false);
    });

    it("drops an expired pairing from the list", () => {
      pair();
      expect(listPairedClients()).toHaveLength(1);
      vi.setSystemTime(start.getTime() + 24 * HOUR + 1000);
      expect(listPairedClients()).toHaveLength(0);
    });

    it("says when a pairing expires", () => {
      pair();
      const [client] = listPairedClients();
      expect(client.expiresAt).toBe(new Date(start.getTime() + 24 * HOUR).toISOString());
    });
  });
});
