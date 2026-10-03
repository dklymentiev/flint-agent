// Free mode: OpenRouter's free models, listed with their current speed and
// uptime, the best picked, two fallbacks kept (docs/free-mode.md).
//
// Free means a zero prompt and completion price, not a ":free" suffix: five
// free models had none on 2026-10-02, stealth/space-bunny-alpha among them.
// Speed and uptime come from OpenRouter's endpoint stats, so listing spends
// no requests from the free daily allowance (50, or 1,000 after a one-time
// $10), which an agent turn of 6-150 calls uses up fast.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const OPENROUTER_API = "https://openrouter.ai/api/v1";
const AVAILABLE_UPTIME = 90;

const vendorOf = (id) => String(id).split("/")[0];

const LIGHT_WORDS = /(^|[-_/.])(mini|small|nano|flash|lightning|lite|xs|tiny)([-_/.:]|$)/i;

/**
 * A light model: small (under 15B parameters by its name) or named as a
 * light variant. Speed alone put a 2.6B model second and the 550B one last
 * (live list, 2026-10-02); OpenRouter gives no quality figure, so the name is
 * the evidence there is.
 */
export function isLight(id) {
  const name = String(id).split("/").slice(1).join("/").replace(/:free$/, "");
  if (LIGHT_WORDS.test(name)) return true;
  const size = name.match(/(?:^|[-_.])(\d+(?:\.\d+)?)b(?![a-z])/i);
  return size ? Number(size[1]) < 15 : false;
}

/** Free models that can call tools and answer in text. */
export function freeCandidates(models) {
  return (models || [])
    .filter((m) => Number(m?.pricing?.prompt) === 0 && Number(m?.pricing?.completion) === 0)
    .filter((m) => (m.supported_parameters || []).includes("tools"))
    .filter((m) => !m.architecture?.output_modalities || m.architecture.output_modalities.includes("text"))
    .filter((m) => vendorOf(m.id) !== "openrouter")          // routers, not models
    .map((m) => ({
      id: m.id,
      name: m.name || m.id,
      vendor: vendorOf(m.id),
      context: m.context_length || null,
      // An anonymous model on trial; such prompts are usually logged.
      stealth: vendorOf(m.id) === "stealth" || /\b(stealth|anonymous)\b/i.test(m.description || ""),
      light: isLight(m.id),
    }));
}

/** Speed, first-token time and uptime from the endpoint with the best uptime. */
export function endpointStats(endpoints) {
  const eps = (endpoints || []).filter(Boolean);
  if (!eps.length) return { tps: null, firstMs: null, uptime: null, provider: null };
  const best = [...eps].sort((a, b) => (b.uptime_last_30m ?? -1) - (a.uptime_last_30m ?? -1))[0];
  return {
    tps: best.throughput_last_30m?.p50 ?? null,
    firstMs: best.latency_last_30m?.p50 ?? null,
    uptime: best.uptime_last_30m ?? null,
    provider: best.provider_name ?? null,
  };
}

const available = (m) => m.uptime == null || m.uptime >= AVAILABLE_UPTIME;

/**
 * Available ones first (uptime >= 90% or no data), then full-size before
 * light ones, then faster, then quicker to start.
 */
export function rankFree(list) {
  return [...(list || [])].sort((a, b) =>
    (available(b) - available(a))
    // A fresh model-check score (model-check.js) is measured; it outranks
    // the guess from the name.
    || ((b.score ?? -1) - (a.score ?? -1))
    || ((a.light ? 1 : 0) - (b.light ? 1 : 0))
    || ((b.tps ?? 0) - (a.tps ?? 0))
    || ((a.firstMs ?? Infinity) - (b.firstMs ?? Infinity)));
}

/** The primary (the best, or the one named) and two fallbacks from other vendors. */
export function freeChain(ranked, primaryId = null) {
  const primary = primaryId || ranked[0]?.id;
  if (!primary) return [];
  const chain = [primary];
  const vendors = new Set([vendorOf(primary)]);
  for (const m of ranked) {
    if (chain.length === 3) break;
    if (m.id === primary || vendors.has(m.vendor)) continue;
    chain.push(m.id);
    vendors.add(m.vendor);
  }
  return chain;
}

/** 50 free requests a day on the free tier, 1,000 once credits were bought. */
export function dailyFreeLimit(keyInfo) {
  return keyInfo && keyInfo.is_free_tier === false ? 1000 : 50;
}

// ── Saved state: the chain and today's count ───────────────

function stateFile() {
  const dir = process.env.FLINT_DATA_DIR ? path.resolve(process.env.FLINT_DATA_DIR) : path.join(homedir(), ".flint");
  return path.join(dir, "free.json");
}
function readState() {
  try { return existsSync(stateFile()) ? JSON.parse(readFileSync(stateFile(), "utf8")) : {}; } catch { return {}; }
}
function writeState(s) {
  try {
    mkdirSync(path.dirname(stateFile()), { recursive: true });
    writeFileSync(stateFile(), JSON.stringify(s, null, 2) + "\n");
  } catch {}
}
const dayOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export function saveFreeChain(chain, limit) {
  const s = readState();
  s.chain = chain && chain.length ? chain : null;
  if (limit) s.limit = limit;
  writeState(s);
}
export function loadFreeChain() {
  return readState().chain || null;
}
export function savedFreeLimit() {
  return readState().limit || 50;
}
export function recordFreeRequest(now = new Date()) {
  const s = readState();
  const day = dayOf(now);
  s.usage = s.usage?.day === day ? { day, count: s.usage.count + 1 } : { day, count: 1 };
  writeState(s);
}
export function freeUsedToday(now = new Date()) {
  const u = readState().usage;
  return u?.day === dayOf(now) ? u.count : 0;
}

// ── The request and its answer ───────────────────────────────

/** In free mode, the main model's request names the chain; nothing else does. */
export function freeRequestFields({ chain, provider, model, mainModel }) {
  if (!chain?.length || provider?.id !== "openrouter" || model !== mainModel) return {};
  return { models: chain };
}

/** One line when a fallback answered instead of the primary, once per change. */
export function createServedModelNotifier() {
  let last;
  return (primary, served) => {
    if (!served) return null;
    if (served === primary) {
      const back = last && last !== primary;
      last = primary;
      return back ? `free: back on ${primary}` : null;
    }
    if (last === served) return null;
    last = served;
    return `free: ${primary} did not answer; ${served} did`;
  };
}

export function paymentRequiredMessage(inFreeMode) {
  if (!inFreeMode) return null;
  return "OpenRouter answered 402: the account balance is below zero, and that blocks free models too. Top up at https://openrouter.ai/credits.";
}

// ── Loading the list ─────────────────────────────────────────

let fetchJsonOverride = null;
/** For tests: replace the network. */
export function setFreeFetchJson(fn) { fetchJsonOverride = fn; }

async function defaultFetchJson(url) {
  const { config } = await import("./config.js");
  const r = await fetch(url, {
    headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {},
    signal: AbortSignal.timeout(15000),
  });
  return r.ok ? r.json() : null;
}

/** The free models, ranked, each with its stats, and the account's daily limit. */
export async function loadFreeModels({ fetchJson = fetchJsonOverride || defaultFetchJson } = {}) {
  const catalog = (await fetchJson(`${OPENROUTER_API}/models`))?.data || [];
  const candidates = freeCandidates(catalog);
  const withStats = await Promise.all(candidates.map(async (m) => {
    try {
      const eps = (await fetchJson(`${OPENROUTER_API}/models/${m.id}/endpoints`))?.data?.endpoints;
      return { ...m, ...endpointStats(eps) };
    } catch {
      return { ...m, ...endpointStats([]) };
    }
  }));
  let key = null;
  try { key = (await fetchJson(`${OPENROUTER_API}/key`))?.data || null; } catch {}
  const { withScores } = await import("./model-check.js");
  return { models: rankFree(withScores(withStats)), limit: dailyFreeLimit(key), freeTier: key ? key.is_free_tier !== false : null };
}

/**
 * Switch to a free chain: the model, its fallbacks, saved, and the price card
 * of the primary for the footer. `log` gets one line.
 */
export async function applyFreeChain({ chain, limit, store, log }) {
  const { config } = await import("./config.js");
  const { setLastModel } = await import("./providers/state.js");
  config.model = chain[0];
  config.freeChain = chain;
  saveFreeChain(chain, limit);
  try { setLastModel(config.provider, chain[0]); } catch {}
  store?.getState().setModel(chain[0]);
  store?.setState({ _freeLimit: limit });
  try {
    const { fetchModelInfo } = await import("./api/client.js");
    const info = await fetchModelInfo(chain[0]);
    if (info) store?.getState().setPricing(info);
  } catch {}
  log?.(`free: ${chain[0]}${chain.length > 1 ? ` (fallbacks: ${chain.slice(1).join(", ")})` : ""} · limit ${limit} requests/day`);
}

/** Leave free mode (another model was chosen). */
export async function clearFreeChain() {
  const { config } = await import("./config.js");
  config.freeChain = null;
  saveFreeChain(null);
}
