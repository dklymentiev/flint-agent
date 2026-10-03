// The URL Flint's own callers use reaches the server it starts (2026-10-02).
// The server bound 127.0.0.1 and the callers fetched http://localhost, which
// Node 22 resolves to ::1 first: ECONNREFUSED for every parent-to-child call.
import { describe, it, expect, vi } from "vitest";
import net from "node:net";

vi.mock("../../src/logging/logger.js", () => ({
  createLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
}));

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  });
}

describe("the API address", () => {
  it("is where the server listens", async () => {
    const { startServer } = await import("../../src/api/server.js");
    const { apiUrl } = await import("../../src/api/address.js");
    const { createMockStore } = await import("../helpers/mock-store.js");
    const port = await freePort();
    const result = await startServer(port, createMockStore(), async () => "ok", { strictPort: true });
    try {
      const res = await fetch(apiUrl(result.port ?? port, "/status"));
      expect(res.status).toBe(200);
    } finally {
      await new Promise((r) => (result.server ?? result).close(r));
    }
  });
});
