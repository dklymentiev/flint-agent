// /key must read the key through the app's own input in secret mode.
//
// Owner, 2026-10-01: /key used a second readline on stdin. The Ink input got
// the same line and submitted it as a chat message, so the API key was sent
// to the model and logged; closing readline also left the terminal out of raw
// mode, after which typing appeared under the status bar.
import { describe, it, expect, vi } from "vitest";
import React from "react";
import { render } from "ink-testing-library";

vi.mock("../../../src/logging/logger.js", () => ({
  createLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
}));

const h = React.createElement;
const tick = (ms = 80) => new Promise((r) => setTimeout(r, ms));
const KEY = "sk-or-v1-0123456789abcdef0123456789";

async function setup() {
  const { App } = await import("../../../src/components/App.js");
  const { createMockStore } = await import("../../helpers/mock-store.js");
  const store = createMockStore();
  const onSubmit = vi.fn();
  const resolve = vi.fn();
  const r = render(h(App, { store, onSubmit, onAbort() {} }));
  await tick();
  store.setState({ secretPrompt: { label: "OpenRouter API key", resolve } });
  await tick();
  return { ...r, store, onSubmit, resolve };
}

describe("App secret input", () => {
  it("hands the key to the waiting command, never to onSubmit", async () => {
    const { stdin, onSubmit, resolve, store } = await setup();
    stdin.write(KEY);
    await tick();
    stdin.write("\r");
    await tick();
    expect(resolve).toHaveBeenCalledWith(KEY);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(store.getState().secretPrompt).toBeNull();
  });

  it("never draws the key", async () => {
    const { stdin, lastFrame } = await setup();
    stdin.write(KEY);
    await tick();
    expect(lastFrame()).not.toContain(KEY);
    expect(lastFrame()).toContain("hidden");
  });

  it("Esc cancels with an empty answer", async () => {
    const { stdin, onSubmit, resolve } = await setup();
    stdin.write("\x1b");
    await tick();
    expect(resolve).toHaveBeenCalledWith("");
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
