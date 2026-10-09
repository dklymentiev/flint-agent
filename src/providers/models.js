// Fetch models from provider API — unified format

import { getProvider } from "./registry.js";
import { createLogger } from "../logging/logger.js";

const log = createLogger("models");

export async function fetchModels(providerId) {
  const provider = getProvider(providerId);
  if (!provider) {
    log.warn("fetchModels: unknown provider", { providerId });
    return [];
  }

  if (!provider.modelsEndpoint) {
    // Static models fallback
    if (provider.staticModels) {
      return provider.staticModels.map((m) => ({
        id: m.id,
        name: m.name || m.id,
        context_length: m.context_length || null,
        pricing: null,
      }));
    }
    return [];
  }

  // Use the resolved key from config (which already honours the headless
  // env-key-wins rule) rather than calling getKey() directly.  Calling
  // getKey() here bypasses config.resolveApiKey() and would silently use a
  // stored key even when the environment key should win in headless mode.
  const { config } = await import("../config.js");
  const apiKey = config.apiKey;

  try {
    const headers = { ...provider.headers };
    if (provider.authType === "bearer" && apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    } else if (provider.authType === "x-api-key" && apiKey) {
      headers["x-api-key"] = apiKey;
    }

    const url = provider.ollamaCompat
      ? `${provider.baseUrl}${provider.modelsEndpoint}`
      : `${provider.baseUrl}${provider.modelsEndpoint}`;

    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      log.warn("fetchModels: http error", { providerId, status: res.status, body: body.slice(0, 200) });
      return [];
    }
    const data = await res.json();

    // Anthropic format: { data: [{ id, display_name, type: "model", created_at }] }
    if (provider.format === "anthropic") {
      const models = data.data || [];
      return models.map((m) => ({
        id: m.id,
        name: m.display_name || m.id,
        context_length: null,
        pricing: null,
      }));
    }

    // Ollama format
    if (provider.ollamaCompat) {
      const models = data.models || [];
      return models.map((m) => ({
        id: m.name || m.model,
        name: m.name || m.model,
        context_length: null,
        pricing: null,
      }));
    }

    // OpenAI-compatible format (OpenRouter, OpenAI, Groq, Together)
    const rawModels = data.data || [];

    // Filter out non-chat models (audio, image, embedding, moderation, tts, realtime, sora, etc.)
    const NON_CHAT = /^(tts|whisper|dall-e|text-embedding|text-moderation|davinci|babbage|canary|omni-moderation|sora|gpt-image|gpt-audio|gpt-realtime|chatgpt-image)/;
    const NON_CHAT_SUFFIX = /(-(audio|realtime|transcribe|tts|diarize)(-|$))/;

    const filtered = rawModels
      .filter((m) => {
        if (NON_CHAT.test(m.id)) return false;
        if (NON_CHAT_SUFFIX.test(m.id)) return false;
        // OpenRouter marks modality — keep only models that output text.
        // New OpenRouter schema uses architecture.output_modalities: ["text", ...]
        // Legacy schema uses architecture.modality: "text->text" or "text+image->text"
        const arch = m.architecture;
        if (arch) {
          if (Array.isArray(arch.output_modalities) && arch.output_modalities.length > 0) {
            if (!arch.output_modalities.includes("text")) return false;
          } else if (typeof arch.modality === "string" && arch.modality) {
            // Check the output side (after "->") — if absent, use whole string
            const outputSide = arch.modality.includes("->")
              ? arch.modality.split("->")[1]
              : arch.modality;
            if (!outputSide.includes("text")) return false;
          }
        }
        return true;
      })
      .map((m) => ({
        id: m.id,
        name: m.name || m.id,
        context_length: m.context_length || null,
        // What the model accepts, when the provider publishes it: true/false
        // for images, null when it does not say.
        sees_images: seesImagesFrom(m.architecture),
        pricing: m.pricing ? {
          prompt: parseFloat(m.pricing.prompt || 0),
          completion: parseFloat(m.pricing.completion || 0),
          // Third price line, two orders of magnitude below `prompt`. Without
          // it any local estimate of a cached call is off by ~100x.
          cacheRead: m.pricing.input_cache_read != null
            ? parseFloat(m.pricing.input_cache_read)
            : null,
        } : null,
      }));

    log.info("fetchModels", { providerId, raw: rawModels.length, filtered: filtered.length });
    return filtered;
  } catch (err) {
    log.warn("fetchModels: exception", { providerId, error: err.message });
    return [];
  }
}

// OpenRouter: architecture.input_modalities ["text", "image", ...], or the
// legacy architecture.modality "text+image->text". Absent means unknown, not no.
export function seesImagesFrom(arch) {
  if (!arch) return null;
  if (Array.isArray(arch.input_modalities) && arch.input_modalities.length > 0) {
    return arch.input_modalities.includes("image");
  }
  if (typeof arch.modality === "string" && arch.modality.includes("->")) {
    return arch.modality.split("->")[0].includes("image");
  }
  return null;
}

export async function fetchModelInfo(providerId, modelId) {
  const models = await fetchModels(providerId);
  const model = models.find((m) => m.id === modelId);
  if (!model) return null;
  return {
    prompt: model.pricing?.prompt || 0,
    completion: model.pricing?.completion || 0,
    cacheRead: model.pricing?.cacheRead ?? null,
    contextLength: model.context_length || null,
    seesImages: model.sees_images ?? null,
  };
}
