// The wizard sets a provider default without asking the provider whether it
// exists (tester, 1.14.5: Ollama "404 model not found", llama3.2 not pulled).
import { describe, it, expect } from "vitest";
import { checkOllamaModel, resolveLiveDefault } from "../../src/model-availability.js";

const tags = (names) => async () => ({ ok: true, json: async () => ({ models: names.map((name) => ({ name })) }) });

describe("checkOllamaModel", () => {
  it("is fine when the model is pulled (tag-insensitive for :latest)", async () => {
    const r = await checkOllamaModel("llama3.2", { fetchImpl: tags(["llama3.2:latest"]) });
    expect(r.status).toBe("ok");
  });
  it("says ollama pull <model> when it is not pulled, and lists what is", async () => {
    const r = await checkOllamaModel("llama3.2", { fetchImpl: tags(["qwen2.5:7b"]) });
    expect(r.status).toBe("missing");
    expect(r.message).toContain("ollama pull llama3.2");
    expect(r.installed).toEqual(["qwen2.5:7b"]);
  });
  it("says Ollama is not running when unreachable", async () => {
    const r = await checkOllamaModel("llama3.2", { fetchImpl: async () => { throw new Error("ECONNREFUSED"); } });
    expect(r.status).toBe("unreachable");
    expect(r.message).toMatch(/ollama serve|not running/i);
  });
});

describe("resolveLiveDefault", () => {
  const models = [{ id: "~vendor/alias-latest" }, { id: "a/model:batch" }, { id: "a/model-1" }, { id: "b/model-2" }];
  it("keeps the default when it is listed", async () => {
    const r = await resolveLiveDefault("openrouter", "b/model-2", { fetchModels: async () => models });
    expect(r).toEqual({ status: "ok", model: "b/model-2" });
  });
  it("offers the first suitable live model when the default is missing", async () => {
    const r = await resolveLiveDefault("openrouter", "google/gone", { fetchModels: async () => models });
    expect(r).toEqual({ status: "missing", model: "google/gone", suggestion: "a/model-1" });
  });
  it("does not guess when the list is unavailable", async () => {
    const r = await resolveLiveDefault("openrouter", "x", { fetchModels: async () => [] });
    expect(r.status).toBe("unknown");
    expect(r.suggestion).toBeUndefined();
  });
});

import { confirmWizardModel } from "../../src/model-availability.js";

describe("confirmWizardModel", () => {
  const asker = (answer) => { const asked = []; return { asked, ask: async (q) => { asked.push(q); return answer; } }; };
  const missing = { resolveLiveDefault: async () => ({ status: "missing", suggestion: "a/model-1" }) };
  it("offers the first live model when the default is missing, and takes yes", async () => {
    const { ask, asked } = asker("");
    const out = await confirmWizardModel("openrouter", "google/gone", { ask, print: () => {}, deps: missing });
    expect(out).toBe("a/model-1");
    expect(asked[0]).toContain("a/model-1");
  });
  it("keeps the default on no", async () => {
    const out = await confirmWizardModel("openrouter", "google/gone", { ask: asker("n").ask, print: () => {}, deps: missing });
    expect(out).toBe("google/gone");
  });
  it("never asks when the default is live or the list is unknown", async () => {
    for (const status of ["ok", "unknown"]) {
      const { ask, asked } = asker("");
      const out = await confirmWizardModel("openrouter", "m", { ask, print: () => {}, deps: { resolveLiveDefault: async () => ({ status }) } });
      expect(out).toBe("m");
      expect(asked).toHaveLength(0);
    }
  });
  it("prints the ollama pull hint for a missing Ollama model", async () => {
    const printed = [];
    const out = await confirmWizardModel("ollama", "llama3.2", {
      ask: asker("n").ask, print: (s) => printed.push(s),
      deps: { checkOllamaModel: async () => ({ status: "missing", installed: ["qwen2.5:7b"], message: "Run: ollama pull llama3.2" }) },
    });
    expect(out).toBe("llama3.2");
    expect(printed.join("\n")).toContain("ollama pull llama3.2");
  });
});
