// The model list of one provider, opened as the pick list: from /provider
// after a provider is picked, and from /model for the provider in use
// (owner, 2026-10-19: /model showed only the current model).

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fetchModels } from "../providers/models.js";
import { getProvider } from "../providers/registry.js";
import { config } from "../config.js";
import { homeStateDir } from "../data-dir.js";

/** Open the list with the marker on the model in use. False when there is none. */
export async function openModelList(store, providerId) {
  const s = store.getState();
  const provider = getProvider(providerId);
  let models = await fetchModels(providerId);

  // Apply curated filter for openrouter (only if user has non-empty ~/.flint/models-curated.json)
  // Project default is empty [] = show all models
  if (providerId === "openrouter") {
    try {
      // homedir(), not process.env.HOME: HOME is unset on Windows.
      const userPath = join(homeStateDir(), "models-curated.json");
      if (existsSync(userPath)) {
        const data = JSON.parse(readFileSync(userPath, "utf-8"));
        const prefixes = Array.isArray(data[providerId]) ? data[providerId] : [];
        if (prefixes.length > 0) {
          models = models.filter((m) => prefixes.some((px) => m.id.startsWith(px)));
        }
      }
    } catch {}
  }

  if (!models.length) {
    s.addLine(`  No models returned from ${provider.name}. Check your API key and network.`);
    s.closeOverlay();
    return false;
  }

  models.sort((a, b) => a.id.localeCompare(b.id));

  const modelItems = models.map((m) => {
    const ctx = m.context_length ? `${(m.context_length / 1000).toFixed(0)}k` : "";
    const price = m.pricing
      ? `$${(m.pricing.prompt * 1e6).toFixed(2)} / $${(m.pricing.completion * 1e6).toFixed(2)}`
      : "";
    return {
      id: m.id,
      ctx,
      price,
      tools: m.tools ?? null,
      caps: [m.sees_images && "img", m.reasoning && "think", m.structured && "json"].filter(Boolean).join(" "),
      description: m.description || null,
      current: m.id === config.model,
      providerId,
      _priceNum: m.pricing ? m.pricing.prompt * 1e6 : Infinity,
      _ctxNum: m.context_length || 0,
    };
  });

  s.overlayDrilldown("model", `Models -- ${provider.name}`, modelItems, {
    providerId,
    providerName: provider.name,
  });
  const current = modelItems.findIndex((m) => m.current);
  if (current > 0) s.overlaySetIndex(current);
  return true;
}
