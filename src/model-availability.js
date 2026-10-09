// Is the model Flint is about to use actually there?
//
// The first-run wizard used to set a provider default blindly. On 1.14.5 that
// gave a tester a 404 on the very first message: Ollama's llama3.2 was not
// pulled, and OpenRouter's list no longer carried the recommended id. These
// helpers ask the provider, and never invent an id: a suggestion is always a
// model the provider listed a moment ago.

import { getProvider } from "./providers/registry.js";
import { fetchModels as realFetchModels } from "./providers/models.js";

const withTag = (name) => (name.includes(":") ? name : `${name}:latest`);

/** Ask Ollama (/api/tags) whether `model` is pulled. */
export async function checkOllamaModel(model, { fetchImpl = fetch, baseUrl } = {}) {
  const base = baseUrl || getProvider("ollama")?.baseUrl || "http://localhost:11434";
  let names;
  try {
    const res = await fetchImpl(`${base}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    names = (data.models || []).map((m) => m.name || m.model).filter(Boolean);
  } catch (err) {
    return {
      status: "unreachable",
      message: `Ollama is not running at ${base} (${err.message}). Start it with: ollama serve`,
    };
  }
  if (names.some((n) => withTag(n) === withTag(model))) return { status: "ok", installed: names };
  return {
    status: "missing",
    installed: names,
    message: `Model "${model}" is not pulled in Ollama. Run: ollama pull ${model}`,
  };
}

/**
 * Check a provider default against the provider's live model list.
 * status: ok | missing (with `suggestion`) | unknown (list unavailable).
 */
export async function resolveLiveDefault(providerId, model, { fetchModels = realFetchModels } = {}) {
  const models = await fetchModels(providerId).catch(() => []);
  if (!models.length) return { status: "unknown", model };
  if (models.some((m) => m.id === model)) return { status: "ok", model };
  // Suitable: a plain id. Skip batch/free/thinking variants ("x:batch") and
  // "~" aliases, which are not what a first-time user should land on.
  const first = models.find((m) => !m.id.includes(":") && !m.id.startsWith("~"));
  return { status: "missing", model, suggestion: first?.id };
}

const isYes = (a) => ["", "y", "yes"].includes(a.trim().toLowerCase());

/**
 * After a provider is chosen: confirm the default exists, or offer a live one.
 * Returns the model to use. `ask(question)` resolves to the typed answer.
 */
export async function confirmWizardModel(providerId, model, { ask, print = console.log, deps = {} } = {}) {
  if (providerId === "ollama") {
    const r = await (deps.checkOllamaModel || checkOllamaModel)(model);
    if (r.status === "ok") return model;
    print(`  ${r.message}`);
    if (r.status === "missing" && r.installed?.length) {
      const pick = r.installed[0];
      if (isYes(await ask(`  Use the installed model ${pick} instead? [Y/n] `))) return pick;
    }
    return model;
  }
  const r = await (deps.resolveLiveDefault || resolveLiveDefault)(providerId, model);
  if (r.status !== "missing") return model;
  print(`  The default model ${model} is not in ${providerId}'s current model list.`);
  if (!r.suggestion) return model;
  return isYes(await ask(`  Use ${r.suggestion} instead? [Y/n] `)) ? r.suggestion : model;
}
