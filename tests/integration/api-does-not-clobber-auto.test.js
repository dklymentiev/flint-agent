// Test that an API message without body.autonomous does not reset the
// TUI's /auto flag (app.autonomous). Previously the server had an
// `else { app.autonomous = false; }` branch that clobbered /auto whenever
// any API message arrived. Now app.autonomous is TUI-only and API
// self-continue uses a separate app.apiSelfContinue flag.

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

describe("API message does not clobber TUI /auto flag", () => {
  it("app.autonomous stays true when API message has autonomous: false", async () => {
    const { startServer } = await import("../../src/api/server.js");
    const { app } = await import("../../src/app-state.js");
    const { createMockStore } = await import("../helpers/mock-store.js");

    // Simulate the TUI /auto command having been run.
    app.autonomous = true;
    app.apiSelfContinue = true;

    const port = await freePort();
    const processMessage = vi.fn(async () => "ok");
    const result = await startServer(port, createMockStore(), processMessage, { strictPort: true });

    try {
      // Send an API message with autonomous: false. The PIN/auth check is
      // not on the /message endpoint — the autonomous handling code runs
      // unauthenticated. The old code would set app.autonomous=false in
      // an else-branch; now it only touches app.apiSelfContinue.
      const res = await fetch(`http://127.0.0.1:${result.port ?? port}/message`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "hello", autonomous: false }),
      });

      // app.autonomous must NOT have been reset — it is the TUI flag.
      expect(app.autonomous).toBe(true);
      // apiSelfContinue should reflect the per-message opt-in (false here).
      expect(app.apiSelfContinue).toBe(false);
      // The message should still be accepted (202, async mode returns immediately).
      expect([200, 202]).toContain(res.status);
    } finally {
      await new Promise((r) => (result.server ?? result).close(r));
      app.autonomous = false;
      app.apiSelfContinue = false;
    }
  });

  it("app.autonomous stays true when API message omits autonomous field", async () => {
    const { startServer } = await import("../../src/api/server.js");
    const { app } = await import("../../src/app-state.js");
    const { createMockStore } = await import("../helpers/mock-store.js");

    app.autonomous = true;

    const port = await freePort();
    const processMessage = vi.fn(async () => "ok");
    const result = await startServer(port, createMockStore(), processMessage, { strictPort: true });

    try {
      await fetch(`http://127.0.0.1:${result.port ?? port}/message`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "hello" }),
      });

      expect(app.autonomous).toBe(true);
      expect(app.apiSelfContinue).toBe(false);
    } finally {
      await new Promise((r) => (result.server ?? result).close(r));
      app.autonomous = false;
      app.apiSelfContinue = false;
    }
  });
});
