# Multi-Provider Support

Flint ships with 7 LLM providers. Switch between them at runtime without restarting.

## Supported Providers

| Provider | id | Format | Auth | Models list | Key Required |
|----------|----|--------|------|-------------|-------------|
| **OpenRouter** | `openrouter` | openai | Bearer | GET /models | yes |
| **OpenAI** | `openai` | openai | Bearer | GET /models | yes |
| **Anthropic** | `anthropic` | anthropic | x-api-key | GET /models?limit=100 | yes |
| **Groq** | `groq` | openai | Bearer | GET /models | yes |
| **Together** | `together` | openai | Bearer | GET /models | yes |
| **Ollama** (local) | `ollama` | openai | none | GET /api/tags | no |
| **Gemini** (OpenAI-compatible endpoint) | `gemini` | openai | Bearer | GET /models | yes |

The list, base URLs and default models are in `config/providers.json`.

## Commands

| Command | Description |
|---------|-------------|
| `/provider` | Open a picker with every provider and its key status; picking one lists its models |
| `/provider <name>` | Switch to a provider (e.g. `/provider anthropic`). Refused when that provider needs a key and none is stored |
| `/key` | Show which providers have stored keys |
| `/key <provider>` | Set the API key for a provider. The key is typed into the input box in secret mode and never reaches the model |
| `/key <provider> delete` | Delete the stored key |
| `/model` | Show the current model, provider, price and context size |
| `/model <id>` | Switch model on the current provider |
| `/model free` | OpenRouter only: list free models that can call tools (see [free-mode.md](free-mode.md)) |
| `/model test [free \| <id> ...]` | Run the model check on one or more models (see [model-check.md](model-check.md)) |

## Tools

| Tool | Description |
|------|-------------|
| `switch_provider` | Switch provider |
| `list_providers` | List all providers with key status |
| `list_models` | List models for the current provider |
| `switch_model` | Switch model (optional `provider` param) |
| `check_balance` | OpenRouter account balance |

## Encrypted Key Storage

Keys are stored encrypted in `~/.flint/keys.enc` (AES-256-GCM).

Key derivation:
- **Windows**: a random seed protected with DPAPI (called through PowerShell), stored in `~/.flint/.seed.dpapi`
- **Linux/Mac**: PBKDF2 over a random seed (`~/.flint/.seed`) and salt (`~/.flint/.salt`)

### Keys from the environment

At start, `OPENROUTER_API_KEY`, `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` (from the environment or `.env`) are imported into encrypted storage when that provider has no stored key yet. The same three variables are also read directly when no stored key exists.

Groq, Together and Gemini have no environment variable: set their keys with `/key groq`, `/key together` or `/key gemini`.

## First-Run Wizard

If no key is found (stored or in those three variables) and the provider is not Ollama, Flint starts an interactive wizard:
1. Choose a provider from the list (or Ollama, which needs no key)
2. Enter the API key
3. The key is encrypted and stored
4. The provider is set as active

## Provider State

The active provider is saved in `~/.flint/provider.json`, with the last-used model for each provider.

Resolution order for the active provider:
1. CLI flag `--provider`
2. Env var `FLINT_PROVIDER`
3. Saved state (`~/.flint/provider.json`)
4. Default: `openrouter`

Resolution order for the model:
1. CLI flag `--model`
2. Env var `OPENROUTER_MODEL` (used whatever the provider)
3. Last-used model for the provider
4. The provider's `defaultModel`

### OpenRouter routing

`OPENROUTER_PROVIDER_ONLY`, `OPENROUTER_PROVIDER_IGNORE` and `OPENROUTER_PROVIDER_ORDER` (comma lists of host slugs) and `OPENROUTER_PROVIDER_SORT` (`price`, `throughput` or `latency`) pin which OpenRouter hosts serve the main model. Unset, OpenRouter picks.

## Anthropic Adapter

Anthropic uses a different message format. The adapter (`src/providers/adapters/anthropic.js`) handles:
- System message: sent as the top-level `system` parameter
- `tool_calls`: sent as `tool_use` content blocks
- `tool` role: sent as `tool_result` content blocks
- Inline images (base64 data URLs): sent as `image` blocks
- Streaming: Anthropic SSE events converted to OpenAI-style deltas
- Headers: `x-api-key` and `anthropic-version: 2023-06-01`

## Child Agent Propagation

When `spawn_agent` creates a child agent:
- `FLINT_PROVIDER` is set to the current provider
- The current key is passed in the provider's variable (`OPENAI_API_KEY` or `ANTHROPIC_API_KEY`; every other provider uses `OPENROUTER_API_KEY`); other API key variables are removed from the child's environment
- The child uses the `model` given to `spawn_agent`; without one it resolves the model as any start does (see above)

## Configuration Files

Provider definitions and curated model lists are JSON files:

| File | Purpose |
|------|---------|
| `config/providers.json` | Bundled provider definitions |
| `config/models-curated.json` | Curated model prefixes for OpenRouter (empty: show all chat models) |
| `~/.flint/providers.json` | User provider definitions. When this file exists it is used instead of the bundled one, so copy the bundled entries you want to keep |
| `~/.flint/models-curated.json` | User curated model prefixes (takes priority over the bundled file) |

To add an OpenAI-compatible provider, add an entry to `~/.flint/providers.json`:

```json
{
  "xai": {
    "name": "xAI",
    "format": "openai",
    "baseUrl": "https://api.x.ai/v1",
    "authType": "bearer",
    "modelsEndpoint": "/models",
    "keyRequired": true,
    "defaultModel": "grok-2"
  }
}
```

Then set the key with `/key xai` and switch with `/provider xai`.

## Files

```
config/
  providers.json        -- Bundled provider definitions
  models-curated.json   -- Curated model prefixes per provider
src/providers/
  registry.js           -- Loads providers from config, with reload support
  keys.js               -- Encrypted key storage (AES-256-GCM)
  keys-dpapi.js         -- Windows DPAPI helper
  keys-fallback.js      -- Linux/Mac PBKDF2 helper
  state.js              -- Active provider and last model per provider
  models.js             -- Unified model listing
  adapters/
    openai.js           -- OpenAI-compatible passthrough
    anthropic.js        -- Anthropic Messages API adapter
```
