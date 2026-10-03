// The app must start and draw while free mode is on.
//
// Owner, 2026-10-02: after /model free picked a chain, Flint crashed with
// React error #185 (maximum update depth) and then crashed on every start,
// because the saved chain switched free mode on at boot. The status selector
// built a new { used, limit } object on every store check, so the snapshot
// never compared equal and React re-rendered without end.
import { describe, it, expect, vi, afterEach } from "vitest";
import React from "react";
import { render } from "ink-testing-library";

vi.mock("../../../src/logging/logger.js", () => ({
  createLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
}));

const h = React.createElement;
const tick = (ms = 80) => new Promise((r) => setTimeout(r, ms));

describe("App in free mode", () => {
  let config;
  afterEach(() => { if (config) config.freeChain = null; });

  it("renders the free quota without an endless re-render", async () => {
    ({ config } = await import("../../../src/config.js"));
    config.freeChain = ["vendor-a/model:free", "vendor-b/model:free"];
    const { App } = await import("../../../src/components/App.js");
    const { createMockStore } = await import("../../helpers/mock-store.js");
    const store = createMockStore();
    store.setState({ _freeLimit: 50 });
    const errors = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...a) => errors.push(a.join(" ")));
    const r = render(h(App, { store, onSubmit() {}, onAbort() {} }));
    await tick();
    // A store update must not set off the loop either.
    store.setState({ activity: "thinking" });
    await tick();
    spy.mockRestore();
    expect(errors.join("\n")).not.toMatch(/185|Maximum update depth/);
    expect(r.lastFrame()).toContain("ready");
    r.unmount();
  });

  it("shows the quota in the status line", async () => {
    const { statusText } = await import("../../../src/components/LiveZone.js");
    expect(statusText({ freeUsed: 3, freeLimit: 50 })).toContain("free 3/50");
    expect(statusText({ freeUsed: null, freeLimit: null })).not.toContain("free ");
  });
});
