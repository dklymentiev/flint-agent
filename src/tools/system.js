import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";

import { processToolDefs, createProcessHandlers, activeChildren, killAllChildren } from "./process-tools.js";
import { agentToolDefs, createAgentHandlers } from "./agent-tools.js";

// Re-export for backward compatibility (used by index.js)
export { killAllChildren };

// HTML → Markdown converter (zero dependencies)
function _htmlToMarkdown(html) {
  let s = html;
  // Remove script, style, noscript, svg, head
  s = s.replace(/<(script|style|noscript|svg|head)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
  // Remove HTML comments
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  // Headings
  s = s.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, "\n# $1\n");
  s = s.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, "\n## $1\n");
  s = s.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, "\n### $1\n");
  s = s.replace(/<h[4-6][^>]*>([\s\S]*?)<\/h[4-6]>/gi, "\n#### $1\n");
  // Links
  s = s.replace(/<a[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)");
  // Images
  s = s.replace(/<img[^>]+alt="([^"]*)"[^>]+src="([^"]*)"[^>]*\/?>/gi, "![$1]($2)");
  s = s.replace(/<img[^>]+src="([^"]*)"[^>]*\/?>/gi, "![]($1)");
  // Bold, italic
  s = s.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, "**$2**");
  s = s.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, "*$2*");
  // Code
  s = s.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, "`$1`");
  s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, "\n```\n$1\n```\n");
  // Lists
  s = s.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "- $1\n");
  s = s.replace(/<\/?[uo]l[^>]*>/gi, "\n");
  // Paragraphs, divs, br
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/p>/gi, "\n\n");
  s = s.replace(/<\/div>/gi, "\n");
  // Table rows → pipe-separated
  s = s.replace(/<tr[^>]*>([\s\S]*?)<\/tr>/gi, (_, row) => {
    const cells = [];
    row.replace(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi, (__, cell) => cells.push(cell.trim()));
    return cells.length ? "| " + cells.join(" | ") + " |\n" : "";
  });
  // Strip remaining tags
  s = s.replace(/<[^>]+>/g, "");
  // Decode entities
  s = s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
  // Collapse whitespace
  s = s.replace(/\n{3,}/g, "\n\n").replace(/[ \t]+/g, " ");
  return s.trim();
}

// Factory: takes store so tools can set pendingAction instead of global flags
export function createSystemTools(store) {
  // Load curated model prefixes from config
  const CURATED_PREFIXES = (() => {
    try {
      const __dir = dirname(fileURLToPath(import.meta.url));
      const cfgPath = join(__dir, "../../config/models-curated.json");
      // homedir(), not process.env.HOME: HOME is unset on Windows.
      const userPath = join(homedir(), ".flint", "models-curated.json");
      for (const p of [userPath, cfgPath]) {
        if (existsSync(p)) {
          const data = JSON.parse(readFileSync(p, "utf-8"));
          return data[config.provider] || data.openrouter || [];
        }
      }
    } catch {}
    return [];
  })();

  const systemToolDefs = [
    {
      type: "function",
      function: {
        name: "web_fetch",
        description: "Fetch a URL and return its text content. Supports GET (default) and POST with JSON body. Useful for checking APIs, downloading configs, reading documentation.",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", description: "URL to fetch" },
            method: { type: "string", enum: ["GET", "POST", "PUT", "DELETE", "PATCH"], description: "HTTP method (default: GET)" },
            body: { type: "string", description: "Request body (JSON string). Used with POST/PUT/PATCH." },
            headers: { type: "object", description: "Extra headers as key-value pairs" },
            max_length: { type: "number", description: "Max response length in chars (default: 5000)" },
          },
          required: ["url"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "web_search",
        description: "Search the web using Google (with DuckDuckGo fallback). Returns titles, URLs and snippets for top results.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query" },
            num_results: { type: "number", description: "Max results to return (default: 5, max: 10)" },
          },
          required: ["query"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "restart_agent",
        description: "Restart the agent process. Session is saved and restored after restart.",
        parameters: {
          type: "object",
          properties: {
            reason: { type: "string", description: "Why the restart is needed" },
          },
          required: ["reason"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "clear_context",
        description: "Clear the conversation history and start fresh (keeps session).",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "check_balance",
        description: "Check the OpenRouter API credit balance and usage.",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "think",
        description: "Think step-by-step before answering. Internal monologue, not shown to user.",
        parameters: {
          type: "object",
          properties: {
            thought: { type: "string", description: "Your reasoning" },
          },
          required: ["thought"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "list_models",
        description: "Show available AI models with pricing for the current provider. Use query to search by name (e.g. 'nvidia', 'nemotron', 'free').",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Optional search filter — matches model ID or name (case-insensitive)" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "switch_model",
        description: "Switch to a different AI model. Optionally switch provider at the same time.",
        parameters: {
          type: "object",
          properties: {
            model_id: { type: "string", description: "The model ID to switch to" },
            provider: { type: "string", description: "Optional: switch provider first (openrouter, openai, anthropic, groq, together, ollama)" },
          },
          required: ["model_id"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "switch_provider",
        description: "Switch to a different LLM provider. Available: openrouter, openai, anthropic, groq, together, ollama.",
        parameters: {
          type: "object",
          properties: {
            provider_id: { type: "string", description: "Provider ID to switch to" },
          },
          required: ["provider_id"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "list_providers",
        description: "List all available LLM providers and which ones have API keys configured.",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "list_mcp_servers",
        description: "List configured MCP servers and their connection status. Use this to check which external tools are reachable and which have dropped (e.g. when a tool returns 'fetch failed').",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "reconnect_mcp",
        description: "Reconnect to an MCP server by name (the name it has in MCP_SERVERS, which is also the middle part of its tool names: mcp_<name>_<tool>). Use this when an MCP tool call fails with network / 'fetch failed' / session errors — the transport stays 'connected' in status but requests don't go through. Reconnect rebuilds the session.",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "MCP server name as shown in list_mcp_servers" },
          },
          required: ["name"],
        },
      },
    },
  ];

  const tools = [...processToolDefs, ...systemToolDefs, ...agentToolDefs];

  const processHandlers = createProcessHandlers(store);
  const agentHandlers = createAgentHandlers(store);

  const systemHandlers = {
    async web_fetch({ url, method, body, headers: extraHeaders, max_length }) {
      const textLimit = max_length || 5000;
      const MAX_BODY = 2 * 1024 * 1024; // 2 MB max download into memory
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);
        const fetchHeaders = { "User-Agent": "Flint/0.7", ...extraHeaders };
        const fetchOpts = { headers: fetchHeaders, signal: controller.signal };
        if (method && method !== "GET") {
          fetchOpts.method = method;
          if (body) {
            fetchOpts.body = body;
            if (!fetchHeaders["Content-Type"]) fetchHeaders["Content-Type"] = "application/json";
          }
        }
        const res = await fetch(url, fetchOpts);
        clearTimeout(timeout);
        if (!res.ok) return `Error: HTTP ${res.status} ${res.statusText}`;

        // Stream body with size cap — never load more than MAX_BODY
        const contentLength = parseInt(res.headers.get("content-length") || "0", 10);
        if (contentLength > MAX_BODY) {
          return `[Large response: ${(contentLength / 1024 / 1024).toFixed(1)} MB. ` +
            `web_fetch limit is 2 MB. Use run_command with curl/wget to download large files to disk.]`;
        }

        const chunks = [];
        let totalBytes = 0;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          totalBytes += value.length;
          if (totalBytes > MAX_BODY) {
            reader.cancel();
            const partial = chunks.join("") + decoder.decode(value, { stream: false });
            const truncated = partial.slice(0, textLimit);
            return `HTTP ${res.status} | ${totalBytes}+ bytes (stopped at 2 MB limit) | Content-Type: ${res.headers.get("content-type")}\n\n` +
              truncated + `\n... (download exceeded 2 MB, truncated. Use run_command with curl/wget for large files.)`;
          }
          chunks.push(decoder.decode(value, { stream: true }));
        }

        let text = chunks.join("") + decoder.decode();
        const ct = res.headers.get("content-type") || "";
        // Auto-convert HTML to Markdown for readability
        if (ct.includes("html") || text.trimStart().startsWith("<!") || text.trimStart().startsWith("<html")) {
          text = _htmlToMarkdown(text);
        }

        // Return factual metadata about size and truncation — the agent
        // decides what to do. Behavioural guidance ("use shell + jq for
        // JSON counting") lives in config/classifier-prompt.md, not in
        // the tool's return value.
        const totalChars = text.length;
        const truncated = totalChars > textLimit;
        const header = truncated
          ? `HTTP ${res.status} | ${ct || "unknown"} | ${totalChars} chars TOTAL, returning first ${textLimit} (TRUNCATED) | ${url}`
          : `HTTP ${res.status} | ${ct || "unknown"} | ${totalChars} chars | ${url}`;
        return `${header}\n\n${truncated ? text.slice(0, textLimit) : text}`;
      } catch (err) {
        return `Error fetching ${url}: ${err.message}`;
      }
    },

    async web_search({ query, num_results }) {
      const max = Math.min(10, Math.max(1, num_results || 5));
      const UA_DESKTOP = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
      const UA_MOBILE = "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36";

      // DuckDuckGo first, then Bing, then Google. Bing answers a scraper with
      // unrelated pages (2026-10-01: "Vitest test framework" returned hotel
      // sites and Microsoft support pages, "Ink react terminal" returned
      // printer ink) while the DuckDuckGo HTML endpoint returned the right
      // results for the same queries.
      let results = await _searchDDG(query, max, UA_DESKTOP);
      if (!results.length) results = await _searchBing(query, max, UA_MOBILE);
      if (!results.length) results = await _searchGoogle(query, max, UA_DESKTOP);
      if (!results.length) return `No results found for "${query}".`;

      const lines = [`Search results for "${query}":\n`];
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        lines.push(`${i + 1}. ${r.title}`);
        lines.push(`   ${r.url}`);
        if (r.snippet) lines.push(`   ${r.snippet}`);
        lines.push("");
      }
      return lines.join("\n").trim();
    },

    async restart_agent({ reason }) {
      // Under a host (headless, stdio) nobody acts on the pending restart, and
      // the model was told "restart done" and believed it (2026-10-02).
      if (config.headless) {
        return "Not available: this agent runs under a host program and cannot restart itself. Its tools are what it has; work with them or say what is missing.";
      }
      store.getState().setPendingAction("restart");
      return `Restart scheduled: ${reason}. Session will be saved and agent will restart.`;
    },

    async clear_context() {
      store.getState().setPendingAction("clear-context");
      return "Context will be cleared after this response.";
    },

    async check_balance() {
      if (config.provider !== "openrouter") {
        return `Balance check is only available for OpenRouter. Current provider: ${config.provider}`;
      }
      try {
        const [creditsRes, keyRes] = await Promise.all([
          fetch("https://openrouter.ai/api/v1/credits", {
            headers: { Authorization: `Bearer ${config.apiKey}` },
          }),
          fetch("https://openrouter.ai/api/v1/auth/key", {
            headers: { Authorization: `Bearer ${config.apiKey}` },
          }),
        ]);
        const credits = await creditsRes.json();
        const key = await keyRes.json();
        const total = credits.data?.total_credits ?? 0;
        const used = credits.data?.total_usage ?? 0;
        const remaining = (total - used).toFixed(2);
        const daily = key.data?.usage_daily?.toFixed(4) ?? "?";
        const weekly = key.data?.usage_weekly?.toFixed(4) ?? "?";
        const monthly = key.data?.usage_monthly?.toFixed(4) ?? "?";
        return [
          `OpenRouter API balance: $${remaining} remaining (of $${total.toFixed(2)} total credits)`,
          `All-time usage (NOT this session): $${used.toFixed(2)}`,
          `Usage breakdown: today $${daily} | this week $${weekly} | this month $${monthly}`,
          `NOTE: This is your OpenRouter account balance, not session cost. Session cost is shown in the stats line after each response.`,
        ].join("\n");
      } catch (err) {
        return `Error checking balance: ${err.message}`;
      }
    },

    async think({ thought }) {
      // Think tool — result is just an acknowledgement
      return "Your thought has been recorded. Continue with your response.";
    },

    async list_models({ query } = {}) {
      try {
        const { fetchModels } = await import("../providers/models.js");
        const { getProvider } = await import("../providers/registry.js");
        const provider = getProvider(config.provider);
        let models = await fetchModels(config.provider);

        if (query) {
          // Search mode — search ALL models by query, ignore curated filter
          const q = query.toLowerCase();
          models = models.filter((m) => m.id.toLowerCase().includes(q) || (m.name || "").toLowerCase().includes(q));
        } else if (config.provider === "openrouter" && CURATED_PREFIXES.length > 0) {
          // Default mode — filter to curated list for OpenRouter (empty = show all)
          models = models.filter((m) => CURATED_PREFIXES.some((p) => m.id.startsWith(p)));
        }

        models.sort((a, b) => a.id.localeCompare(b.id));

        if (!models.length) return `No models found for ${provider?.name || config.provider}.`;
        const lines = [`Available models (${provider?.name || config.provider}):\n`];
        const current = config.model;
        for (const m of models) {
          const p = m.pricing || {};
          const inPrice = (parseFloat(p.prompt || 0) * 1e6).toFixed(2);
          const outPrice = (parseFloat(p.completion || 0) * 1e6).toFixed(2);
          const ctx = m.context_length ? `${(m.context_length / 1000).toFixed(0)}k` : "?";
          const marker = m.id === current ? " ← current" : "";
          const priceStr = p.prompt || p.completion ? `  $${inPrice}/$${outPrice} per 1M` : "";
          lines.push(`${m.id}${priceStr}  ctx:${ctx}${marker}`);
        }
        return lines.join("\n");
      } catch (err) {
        return `Error: ${err.message}`;
      }
    },

    async switch_model({ model_id, provider: providerArg }) {
      // Optionally switch provider first
      if (providerArg && providerArg !== config.provider) {
        const result = await handlers.switch_provider({ provider_id: providerArg });
        if (result.startsWith("Error")) return result;
      }

      const { fetchModelInfo } = await import("../api/client.js");
      const { setLastModel } = await import("../providers/state.js");
      const info = await fetchModelInfo(model_id);
      config.model = model_id;
      store.getState().setModel(model_id);
      setLastModel(config.provider, model_id);
      if (info) {
        store.getState().setPricing(info);
        return `Switched to ${model_id} (${config.provider}). Pricing: $${(info.prompt * 1e6).toFixed(2)}/$${(info.completion * 1e6).toFixed(2)} per 1M tokens.`;
      }
      return `Switched to ${model_id} (${config.provider}). No pricing info available.`;
    },

    async switch_provider({ provider_id }) {
      const { getProvider } = await import("../providers/registry.js");
      const { hasKey } = await import("../providers/keys.js");
      const { setActiveProvider, getLastModel } = await import("../providers/state.js");

      const provider = getProvider(provider_id);
      if (!provider) return `Error: unknown provider "${provider_id}". Use list_providers to see available options.`;

      if (provider.keyRequired && !hasKey(provider_id)) {
        return `Error: no API key configured for ${provider.name}. Use /key ${provider_id} to set one.`;
      }

      config.provider = provider_id;
      setActiveProvider(provider_id);

      // Resolve model for new provider
      const lastModel = getLastModel(provider_id);
      const model = lastModel || provider.defaultModel;
      config.model = model;
      store.getState().setModel(model);
      store.getState().setProvider(provider_id);

      // Resolve API key for new provider
      await config.resolveApiKey();

      // Fetch pricing for new model
      const { fetchModelInfo } = await import("../api/client.js");
      const info = await fetchModelInfo(model);
      if (info) store.getState().setPricing(info);

      return `Switched to ${provider.name} (${model}).`;
    },

    async list_providers() {
      const { listProviders } = await import("../providers/registry.js");
      const { hasKey } = await import("../providers/keys.js");
      const providers = listProviders();
      const lines = ["Available providers:\n"];
      for (const p of providers) {
        const keyStatus = p.keyRequired
          ? (hasKey(p.id) ? "key: yes" : "key: no")
          : "no key needed";
        const marker = p.id === config.provider ? " <-- current" : "";
        lines.push(`${p.id.padEnd(12)} ${p.name.padEnd(16)} ${keyStatus}${marker}`);
      }
      lines.push("\nUse switch_provider to change, or /key <provider> to add a key.");
      return lines.join("\n");
    },

    async list_mcp_servers() {
      const { getMcpServerStatus } = await import("./registry.js");
      const servers = getMcpServerStatus();
      if (!servers.length) return "No MCP servers configured.";
      const lines = ["MCP Servers:"];
      for (const s of servers) {
        lines.push(`  ${s.connected ? "[+]" : "[ ]"} ${s.name}  ${s.url}`);
      }
      return lines.join("\n");
    },

    async reconnect_mcp({ name }) {
      if (!name || typeof name !== "string") {
        return "Error: name is required: the server's name in MCP_SERVERS, as in mcp_<name>_<tool>.";
      }
      const { mcpReconnect, getMcpServerStatus } = await import("./registry.js");
      const before = getMcpServerStatus().find((s) => s.name === name);
      if (!before) {
        const names = getMcpServerStatus().map((s) => s.name).join(", ");
        return `Error: no MCP server named "${name}". Configured: ${names || "(none)"}.`;
      }
      try {
        const result = await mcpReconnect(name);
        const after = getMcpServerStatus().find((s) => s.name === name);
        if (result && result.ok === false) {
          return `Reconnect attempted for ${name}. Still [${after?.connected ? "+" : " "}] — error: ${result.error || "unknown"}.`;
        }
        return `Reconnected ${name}. Status: [${after?.connected ? "+" : " "}] ${after?.url || ""}`;
      } catch (err) {
        return `Reconnect ${name} failed: ${err.message || String(err)}`;
      }
    },
  };

  const handlers = { ...processHandlers, ...systemHandlers, ...agentHandlers };

  return { tools, handlers };
}

// ── Web search helpers ──

function decodeHTMLEntities(text) {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function stripTags(html) {
  return html.replace(/<[^>]+>/g, "").trim();
}

async function _searchBing(query, max, ua) {
  try {
    const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${max}`;
    const res = await fetch(url, {
      headers: { "User-Agent": ua },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return [];
    const html = await res.text();
    return parseBingHTML(html, max);
  } catch {
    return [];
  }
}

function parseBingHTML(html, max = 5) {
  const results = [];
  // Parse organic results from b_algo blocks
  const blocks = html.match(/<li class="b_algo"[\s\S]*?<\/li>/g) || [];
  for (const block of blocks) {
    if (results.length >= max) break;
    const link = block.match(/<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!link) continue;
    const url = decodeHTMLEntities(link[1]);
    const title = decodeHTMLEntities(stripTags(link[2])).trim();
    if (!title || title.length < 5) continue;
    // Extract snippet from <p> or <span> after the link
    const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/) || block.match(/<span class="[^"]*algoSlug[^"]*"[^>]*>([\s\S]*?)<\/span>/);
    const snippet = snippetMatch ? decodeHTMLEntities(stripTags(snippetMatch[1])).slice(0, 200) : "";
    results.push({ title: title.slice(0, 150), url, snippet });
  }
  return results;
}

async function _searchGoogle(query, max, ua) {
  try {
    const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&num=${max}&hl=en`;
    const res = await fetch(url, {
      headers: { "User-Agent": ua },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return [];
    const html = await res.text();
    return parseGoogleHTML(html, max);
  } catch {
    return [];
  }
}

export function parseGoogleHTML(html, max = 5) {
  const results = [];
  // Google wraps results in <div class="g"> or similar; extract <a href="/url?q=..."> + <h3>
  const blockRe = /<a\s+href="\/url\?q=([^&"]+)[^"]*"[^>]*>.*?<h3[^>]*>(.*?)<\/h3>/gs;
  let match;
  while ((match = blockRe.exec(html)) && results.length < max) {
    const url = decodeURIComponent(match[1]);
    const title = decodeHTMLEntities(stripTags(match[2]));
    if (!title || url.startsWith("/") || url.includes("google.com")) continue;
    results.push({ title, url, snippet: "" });
  }

  // Try to extract snippets — they usually follow in a nearby <span> or <div>
  // This is best-effort since Google's HTML changes
  if (results.length) {
    const snippetRe = /<span[^>]*class="[^"]*(?:st|IsZvec|VwiC3b)[^"]*"[^>]*>(.*?)<\/span>/gs;
    let i = 0;
    while ((match = snippetRe.exec(html)) && i < results.length) {
      const text = decodeHTMLEntities(stripTags(match[1])).slice(0, 200);
      if (text.length > 20) {
        results[i].snippet = text;
        i++;
      }
    }
  }

  return results;
}

async function _searchDDG(query, max, ua) {
  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      headers: { "User-Agent": ua },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return [];
    const html = await res.text();
    return parseDDGHTML(html, max);
  } catch {
    return [];
  }
}

export function parseDDGHTML(html, max = 5) {
  const results = [];
  // DDG HTML results: <a class="result__a" href="...">title</a>
  // Snippet: <a class="result__snippet" ...>text</a>
  const linkRe = /<a\s+[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gs;
  const snippetRe = /<a\s+[^>]*class="result__snippet"[^>]*>(.*?)<\/a>/gs;

  let match;
  while ((match = linkRe.exec(html)) && results.length < max) {
    let url = match[1];
    const title = decodeHTMLEntities(stripTags(match[2]));
    if (!title) continue;
    // DDG sometimes wraps URLs through redirect
    if (url.includes("uddg=")) {
      const m = url.match(/uddg=([^&]+)/);
      if (m) url = decodeURIComponent(m[1]);
    }
    results.push({ title, url, snippet: "" });
  }

  // Extract snippets
  let i = 0;
  while ((match = snippetRe.exec(html)) && i < results.length) {
    results[i].snippet = decodeHTMLEntities(stripTags(match[1])).slice(0, 200);
    i++;
  }

  return results;
}
