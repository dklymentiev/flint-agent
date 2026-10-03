// The HTTP API lets a program in only after the operator paired it (owner,
// 2026-10-02). Before, any program running as the same user could read
// ~/.flint/api-token.json and send tasks that ran with the API's automatic
// approval; that is how a benchmark runner drove a console it was never
// meant to reach. Pairing is once per program: the paired token survives a
// restart, stored only as a hash, until the operator revokes it.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("../../../src/logging/logger.js", () => ({
  createLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
}));

// A home of this file's own: pairing.test.js resets the same paired-clients
// file in the shared test sandbox, and the two may run at the same time.
const OWN_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "flint-pairing-home-"));
process.env.HOME = OWN_HOME;
process.env.USERPROFILE = OWN_HOME;

const flintDir = () => path.join(os.homedir(), ".flint");
const tokenFile = () => path.join(flintDir(), "api-token.json");

function req(authorization, url = "/message") {
  return { method: "POST", url, headers: { authorization } };
}
function res() {
  const r = { statusCode: null, writeHead(c) { r.statusCode = c; }, end() {} };
  return r;
}

async function freshModules() {
  vi.resetModules();
  const pairing = await import("../../../src/security/pairing.js");
  const auth = await import("../../../src/security/api-auth.js");
  return { pairing, auth };
}

async function pairOnce(pairing, name = "my-script") {
  const s = pairing.createPairingSession("127.0.0.1");
  const v = pairing.verifyPin(s.sessionId, s.pin, { name, address: "127.0.0.1" });
  expect(v.valid).toBe(true);
  return v.token;
}

describe("API access by default", () => {
  let savedEnv;
  beforeEach(async () => {
    savedEnv = { file: process.env.FLINT_API_TOKEN_FILE, secret: process.env.AGENT_PAIRING_SECRET };
    delete process.env.FLINT_PAIRING_TTL_HOURS;
    delete process.env.FLINT_API_TOKEN_FILE;
    delete process.env.AGENT_PAIRING_SECRET;
    fs.rmSync(tokenFile(), { force: true });
    const { pairing } = await freshModules();
    pairing.revokePairedClients("all");
  });
  afterEach(() => {
    if (savedEnv.file === undefined) delete process.env.FLINT_API_TOKEN_FILE; else process.env.FLINT_API_TOKEN_FILE = savedEnv.file;
    if (savedEnv.secret === undefined) delete process.env.AGENT_PAIRING_SECRET; else process.env.AGENT_PAIRING_SECRET = savedEnv.secret;
  });

  it("writes no token file and accepts no token from one", async () => {
    // A token file left by an older version must not open the door either.
    fs.mkdirSync(flintDir(), { recursive: true });
    fs.writeFileSync(tokenFile(), JSON.stringify({ token: "leftover-token-0123456789abcdef", expiresAt: Date.now() + 1e9 }));
    const { auth } = await freshModules();
    const master = auth.masterTokenIfEnabled();
    expect(master).toBe(null);
    const mw = auth.createAuthMiddleware(master);
    const r = res();
    expect(mw(req("Bearer leftover-token-0123456789abcdef"), r)).toBe(false);
    expect(r.statusCode).toBe(403);
  });

  it("refuses a request with no token at all", async () => {
    const { auth } = await freshModules();
    const r = res();
    expect(auth.createAuthMiddleware(null)(req(undefined), r)).toBe(false);
    expect(r.statusCode).toBe(401);
  });

  it("lets a paired program in, also after a restart", async () => {
    let { pairing, auth } = await freshModules();
    const token = await pairOnce(pairing);
    expect(auth.createAuthMiddleware(null)(req(`Bearer ${token}`), res())).toBe(true);

    ({ pairing, auth } = await freshModules()); // a restart: module state gone
    expect(auth.createAuthMiddleware(null)(req(`Bearer ${token}`), res())).toBe(true);
  });

  it("refuses a paired program once its day is over and forgets it on disk", async () => {
    // The pairing is a day long by default: a program paired once and then
    // forgotten must not still be let in a month later.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-10-03T12:00:00Z"));
      let { pairing, auth } = await freshModules();
      const token = await pairOnce(pairing);
      const file = path.join(flintDir(), "paired-clients.json");

      vi.setSystemTime(new Date("2026-10-04T11:00:00Z"));
      expect(auth.createAuthMiddleware(null)(req(`Bearer ${token}`), res())).toBe(true);

      vi.setSystemTime(new Date("2026-10-04T12:00:01Z"));
      ({ pairing, auth } = await freshModules()); // a restart does not renew it
      const r = res();
      expect(auth.createAuthMiddleware(null)(req(`Bearer ${token}`), r)).toBe(false);
      expect(r.statusCode).toBe(403);
      expect(fs.readFileSync(file, "utf8")).not.toContain("my-script");
    } finally {
      vi.useRealTimers();
    }
  });

  it("stores the paired token only as a hash", async () => {
    const { pairing } = await freshModules();
    const token = await pairOnce(pairing);
    const stored = fs.readFileSync(path.join(flintDir(), "paired-clients.json"), "utf8");
    expect(stored).toContain("my-script");
    expect(stored).not.toContain(token);
  });

  it("lists paired programs and revokes one by name", async () => {
    let { pairing, auth } = await freshModules();
    const a = await pairOnce(pairing, "bench");
    const b = await pairOnce(pairing, "editor");
    expect(pairing.listPairedClients().map((c) => c.name).sort()).toEqual(["bench", "editor"]);

    expect(pairing.revokePairedClients("bench")).toBe(1);
    ({ pairing, auth } = await freshModules());
    const mw = auth.createAuthMiddleware(null);
    expect(mw(req(`Bearer ${a}`), res())).toBe(false);
    expect(mw(req(`Bearer ${b}`), res())).toBe(true);
  });

  it("still lets a child agent in with its spawn secret", async () => {
    process.env.AGENT_PAIRING_SECRET = "spawn-secret-0123456789abcdef0123";
    const { auth } = await freshModules();
    expect(auth.createAuthMiddleware(null)(req("Bearer spawn-secret-0123456789abcdef0123"), res())).toBe(true);
  });

  it("uses the token file only when FLINT_API_TOKEN_FILE=1 says so", async () => {
    process.env.FLINT_API_TOKEN_FILE = "1";
    const { auth } = await freshModules();
    const master = auth.masterTokenIfEnabled();
    expect(typeof master).toBe("string");
    expect(JSON.parse(fs.readFileSync(tokenFile(), "utf8")).token).toBe(master);
    expect(auth.createAuthMiddleware(master)(req(`Bearer ${master}`), res())).toBe(true);
  });
});
