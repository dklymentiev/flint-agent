// The first-run wizard uses the model the availability check gives back.
//
// ceb95be added confirmWizardModel() (is the default pulled in Ollama, is it
// still in the provider's list) and called it from the wizard in two places.
// tests/unit/model-availability.test.js covers the function. Nothing covered
// the two calls: with either one removed the wizard went back to setting the
// default blindly, which is the 404 on the very first message that the commit
// was for, and every test stayed green.
//
// The check itself is replaced here; what is under test is that the wizard
// asks it, with the right provider and default, and keeps its answer.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const answers = vi.hoisted(() => ({ queue: [] }));
vi.mock("node:readline", () => {
  const createInterface = () => ({
    question: (q, cb) => cb(answers.queue.shift() ?? ""),
    close: () => {},
  });
  return { default: { createInterface }, createInterface };
});

const mockConfig = vi.hoisted(() => ({ provider: "none", model: "none", apiKey: "" }));
vi.mock("../../src/config.js", () => ({ config: mockConfig, needsFirstRunSetup: true }));
vi.mock("../../src/sessions.js", () => ({ listSessions: async () => [] }));

const keys = vi.hoisted(() => ({ setKey: vi.fn(async () => {}) }));
vi.mock("../../src/providers/keys.js", () => ({
  migrateEnvKey: async () => {},
  setKey: keys.setKey,
  hasKey: () => false,
}));

vi.mock("../../src/providers/registry.js", () => ({
  listProviders: () => [
    { id: "openrouter", name: "OpenRouter", keyRequired: true, defaultModel: "vendor/release-default" },
    { id: "ollama", name: "Ollama", keyRequired: false, defaultModel: "llama3.2" },
  ],
  getProvider: () => null,
}));

const state = vi.hoisted(() => ({ setActiveProvider: vi.fn(), setLastModel: vi.fn() }));
vi.mock("../../src/providers/state.js", () => state);

const check = vi.hoisted(() => ({ confirmWizardModel: vi.fn() }));
vi.mock("../../src/model-availability.js", () => check);

const { runFirstRunSetup } = await import("../../src/cli.js");

const A_REAL_LOOKING_KEY = "sk-or-v1-0123456789abcdef0123456789abcdef";

describe("first-run wizard: the model is the one that was checked", () => {
  beforeEach(() => {
    mockConfig.provider = "none";
    mockConfig.model = "none";
    keys.setKey.mockClear();
    state.setActiveProvider.mockClear();
    state.setLastModel.mockClear();
    check.confirmWizardModel.mockReset();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("a provider with a key: the default is checked against the provider and the live model is used", async () => {
    check.confirmWizardModel.mockResolvedValue("vendor/live-model");
    answers.queue = ["1", A_REAL_LOOKING_KEY];

    await runFirstRunSetup({ action: "chat" });

    expect(keys.setKey).toHaveBeenCalledWith("openrouter", A_REAL_LOOKING_KEY);
    expect(check.confirmWizardModel).toHaveBeenCalledTimes(1);
    expect(check.confirmWizardModel.mock.calls[0].slice(0, 2)).toEqual(["openrouter", "vendor/release-default"]);
    expect(typeof check.confirmWizardModel.mock.calls[0][2]?.ask, "the check cannot ask the user").toBe("function");
    expect(mockConfig.model).toBe("vendor/live-model");
    // A model other than the release default has to survive a restart.
    expect(state.setLastModel).toHaveBeenCalledWith("openrouter", "vendor/live-model");
    expect(console.log.mock.calls.flat().join("\n")).toContain("vendor/live-model");
  });

  it("a provider with a key: a default that is live is kept and not written as a last model", async () => {
    check.confirmWizardModel.mockResolvedValue("vendor/release-default");
    answers.queue = ["1", A_REAL_LOOKING_KEY];

    await runFirstRunSetup({ action: "chat" });

    expect(mockConfig.model).toBe("vendor/release-default");
    expect(state.setLastModel).not.toHaveBeenCalled();
  });

  it("Ollama: the model is checked for being pulled and the installed one is used", async () => {
    check.confirmWizardModel.mockResolvedValue("qwen2.5:7b");
    answers.queue = ["2"]; // one keyed provider listed, so Ollama is number 2

    await runFirstRunSetup({ action: "chat" });

    expect(mockConfig.provider).toBe("ollama");
    expect(check.confirmWizardModel).toHaveBeenCalledTimes(1);
    expect(check.confirmWizardModel.mock.calls[0].slice(0, 2)).toEqual(["ollama", "llama3.2"]);
    expect(mockConfig.model).toBe("qwen2.5:7b");
    expect(state.setLastModel).toHaveBeenCalledWith("ollama", "qwen2.5:7b");
  });
});
