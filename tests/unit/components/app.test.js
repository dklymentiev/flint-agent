// App component tests — Phase R9
// App is the root component; it has heavy coupling (useInput, raw stdin, store
// subscriptions). We test only that it mounts and renders core elements.
import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { render } from "ink-testing-library";

vi.mock("../../../src/logging/logger.js", () => ({
  createLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
}));

const h = React.createElement;

let App;
let createMockStore;

beforeEach(async () => {
  ({ App } = await import("../../../src/components/App.js"));
  ({ createMockStore } = await import("../../helpers/mock-store.js"));
});

describe("App", () => {
  it("renders without crashing with a minimal store", () => {
    const store = createMockStore();
    let result;
    expect(() => {
      result = render(h(App, { store, onSubmit: () => {}, onAbort: () => {} }));
    }).not.toThrow();
    expect(result.lastFrame()).toBeDefined();
    result.unmount();
  });

  it("has one status line and no tabs", () => {
    const store = createMockStore();
    const { lastFrame, unmount } = render(
      h(App, { store, onSubmit: () => {}, onAbort: () => {} }),
    );
    const frame = lastFrame() || "";
    expect(frame).toContain("· ready");
    expect(frame).not.toContain("Tool Log");
    expect(frame).not.toContain("(Tab)");
    unmount();
  });

  it("accepts an onSubmit prop without error", () => {
    const store = createMockStore();
    const onSubmit = vi.fn();
    const { unmount } = render(
      h(App, { store, onSubmit, onAbort: () => {} }),
    );
    // Just verify the prop wiring works (the handler is wired into TextInput
    // and useInput; we cannot exercise it directly via the testing stdin
    // because raw-mode keypress dispatch is asynchronous, but the wiring
    // itself must not throw at mount time).
    expect(onSubmit).not.toHaveBeenCalled();
    unmount();
  });

  it("renders an input prompt indicator", () => {
    const store = createMockStore();
    const { lastFrame, unmount } = render(
      h(App, { store, onSubmit: () => {}, onAbort: () => {} }),
    );
    // The input row prefixes a green "> "
    expect(lastFrame()).toContain(">");
    unmount();
  });
});
