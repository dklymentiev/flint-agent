import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  generateApiToken,
  createAuthMiddleware,
} from "../../../src/security/api-auth.js";

describe("api-auth", () => {
  describe("generateApiToken", () => {
    it("returns a 48-character hex string", () => {
      const token = generateApiToken();
      expect(token).toMatch(/^[0-9a-f]{48}$/);
    });

    it("returns different values on each call", () => {
      const t1 = generateApiToken();
      const t2 = generateApiToken();
      expect(t1).not.toBe(t2);
    });
  });

  describe("createAuthMiddleware", () => {
    function makeReq({ method = "POST", url = "/api/chat", authorization } = {}) {
      return {
        method,
        url,
        headers: { authorization },
      };
    }

    function makeRes() {
      const res = {
        statusCode: null,
        headers: {},
        body: null,
        writeHead(code, headers) {
          res.statusCode = code;
          res.headers = { ...res.headers, ...headers };
        },
        end(body) {
          res.body = body;
        },
      };
      return res;
    }

    // No token-file key is the default now, and it must not mean "no auth":
    // that fail-open let any local program in (owner, 2026-10-02).
    describe("when no token configured", () => {
      it("refuses a request without a token", () => {
        const mw = createAuthMiddleware(null);
        const res = makeRes();
        expect(mw(makeReq(), res)).toBe(false);
        expect(res.statusCode).toBe(401);
      });

      it("refuses an unknown token", () => {
        const mw = createAuthMiddleware(undefined);
        const res = makeRes();
        expect(mw(makeReq({ authorization: "Bearer not-paired-0123456789" }), res)).toBe(false);
        expect(res.statusCode).toBe(403);
      });
    });

    describe("when token is configured", () => {
      const token = "abc123def456";
      let mw;

      beforeEach(() => {
        mw = createAuthMiddleware(token);
      });

      it("allows OPTIONS requests (CORS preflight)", () => {
        const res = makeRes();
        expect(mw(makeReq({ method: "OPTIONS" }), res)).toBe(true);
      });

      it("allows GET /status (health check)", () => {
        const res = makeRes();
        expect(mw(makeReq({ method: "GET", url: "/status" }), res)).toBe(true);
      });

      it("rejects requests without Authorization header (401)", () => {
        const res = makeRes();
        const result = mw(makeReq({ authorization: undefined }), res);
        expect(result).toBe(false);
        expect(res.statusCode).toBe(401);
      });

      it("rejects requests with wrong token (403)", () => {
        const res = makeRes();
        const result = mw(
          makeReq({ authorization: "Bearer wrong_token" }),
          res
        );
        expect(result).toBe(false);
        expect(res.statusCode).toBe(403);
      });

      it("rejects requests with wrong scheme (403)", () => {
        const res = makeRes();
        const result = mw(
          makeReq({ authorization: `Basic ${token}` }),
          res
        );
        expect(result).toBe(false);
        expect(res.statusCode).toBe(403);
      });

      it("accepts requests with correct Bearer token", () => {
        const res = makeRes();
        const result = mw(
          makeReq({ authorization: `Bearer ${token}` }),
          res
        );
        expect(result).toBe(true);
      });

      it("is case-insensitive for 'Bearer' scheme", () => {
        const res = makeRes();
        const result = mw(
          makeReq({ authorization: `bearer ${token}` }),
          res
        );
        expect(result).toBe(true);
      });

      it("rejects malformed Authorization header (403)", () => {
        const res = makeRes();
        const result = mw(makeReq({ authorization: token }), res);
        expect(result).toBe(false);
        expect(res.statusCode).toBe(403);
      });
    });
  });
});
