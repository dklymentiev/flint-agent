// Session slice: messages, sessionId, cost, tokens, model, provider, inputHistory, profile, plan

import { resetSessionSpend } from "../agent/usage.js";
import { resetVision, setModelSeesImages } from "../agent/vision.js";

/**
 * Rough size of a conversation in tokens (4 characters a token), for the
 * context counter before the model has answered once. A loaded session used
 * to show no context at all until the next reply (owner, 2026-10-02).
 */
export function estimateContextTokens(messages) {
  let chars = 0;
  for (const m of messages || []) {
    if (typeof m?.content === "string") chars += m.content.length;
    else if (m?.content != null) chars += JSON.stringify(m.content).length;
    if (m?.tool_calls) chars += JSON.stringify(m.tool_calls).length;
  }
  return Math.ceil(chars / 4);
}

function mergeSource(bySource, source, entry) {
  const prev = bySource[source] || {
    calls: 0, promptTokens: 0, completionTokens: 0,
    cachedTokens: 0, cacheWriteTokens: 0, cost: 0, estimated: false,
  };
  return {
    ...bySource,
    [source]: {
      calls: prev.calls + (entry.calls || 0),
      promptTokens: prev.promptTokens + (entry.promptTokens || 0),
      completionTokens: prev.completionTokens + (entry.completionTokens || 0),
      cachedTokens: prev.cachedTokens + (entry.cachedTokens || 0),
      cacheWriteTokens: prev.cacheWriteTokens + (entry.cacheWriteTokens || 0),
      cost: prev.cost + (entry.cost || 0),
      estimated: prev.estimated || !!entry.estimated,
    },
  };
}

export const createSessionSlice = (set, get) => ({
  sessionId: null,
  messages: [],
  model: null,
  provider: null,
  pricing: null,
  contextLimit: null,
  sessionCost: 0,
  sessionPromptTokens: 0,
  sessionCompletionTokens: 0,
  // What the number is made of. sessionCost is the real charge when the
  // provider reports one; sessionCostEstimated says when any part of it is a
  // guess. Cached tokens are a subset of sessionPromptTokens.
  sessionCachedTokens: 0,
  sessionCacheWriteTokens: 0,
  sessionCostEstimated: false,
  // Per caller, so "what is even counted here" has an answer on screen:
  // the main loop, the intent classifier, the judge, the reflection extractor.
  sessionUsageBySource: {},
  lastContextTokens: 0,
  inputHistory: [],
  profile: null,
  lastSummary: null,
  plan: null,
  pastedImages: [],
  userMessageCount: 0,

  setSession(sessionId, messages, inputHistory) {
    const userCount = messages ? messages.filter((m) => m.role === "user").length : 0;
    // The ledger follows the session. Seven places clear the session; wiring
    // each of them to also clear the ledger is how the two drift apart, and a
    // session ceiling enforced against a stale total is worse than none.
    resetSessionSpend();
    set({
      sessionId,
      messages,
      inputHistory: inputHistory || [],
      userMessageCount: userCount,
      // An estimate until the model answers and reports the real size.
      lastContextTokens: (messages?.length || 0) > 1 ? estimateContextTokens(messages) : 0,
      contextEstimated: (messages?.length || 0) > 1,
      sessionCost: 0,
      sessionPromptTokens: 0,
      sessionCompletionTokens: 0,
      sessionCachedTokens: 0,
      sessionCacheWriteTokens: 0,
      sessionCostEstimated: false,
      sessionUsageBySource: {},
    });
  },

  setModel(model) {
    // What was learned about the old model's eyes says nothing about the new
    // one. Every model switch passes here, and the provider's answer for the
    // new model arrives through setPricing.
    if (get().model !== model) resetVision();
    set({ model });
  },

  setProvider(providerId) {
    set({ provider: providerId });
  },

  setPricing(pricing) {
    if (pricing && pricing.seesImages != null) setModelSeesImages(pricing.seesImages, "provider-metadata");
    set({
      pricing,
      contextLimit: pricing?.contextLength || null,
    });
  },

  pushMessage(msg) {
    const s = get();
    const newMessages = [...s.messages, msg];
    const update = { messages: newMessages };
    if (msg.role === "user") update.userMessageCount = s.userMessageCount + 1;
    set(update);
  },

  /**
   * Fold one drained ledger into the session totals, for display.
   *
   * There used to be two of these: addUsage(stats, cost) for the main loop and
   * addSideUsage(bySource) for everything else, each with its own idea of what
   * a call cost. The main loop is a source like any other now, so there is one
   * way in.
   *
   * @param {object} bySource - map of source -> usage entry, from drainUsage()
   */
  addUsage(bySource) {
    const s = get();
    let promptTokens = 0, completionTokens = 0, cached = 0, cacheWrite = 0, cost = 0, estimated = false;
    let merged = s.sessionUsageBySource;
    for (const [source, entry] of Object.entries(bySource || {})) {
      if (!entry || !entry.calls) continue;
      promptTokens += entry.promptTokens || 0;
      completionTokens += entry.completionTokens || 0;
      cached += entry.cachedTokens || 0;
      cacheWrite += entry.cacheWriteTokens || 0;
      cost += entry.cost || 0;
      if (entry.estimated) estimated = true;
      merged = mergeSource(merged, source, entry);
    }
    if (merged === s.sessionUsageBySource) return;
    set({
      sessionPromptTokens: s.sessionPromptTokens + promptTokens,
      sessionCompletionTokens: s.sessionCompletionTokens + completionTokens,
      sessionCachedTokens: s.sessionCachedTokens + cached,
      sessionCacheWriteTokens: s.sessionCacheWriteTokens + cacheWrite,
      sessionCost: s.sessionCost + cost,
      sessionCostEstimated: s.sessionCostEstimated || estimated,
      sessionUsageBySource: merged,
    });
  },

  pushInputHistory(input) {
    const { inputHistory } = get();
    set({ inputHistory: [...inputHistory, input] });
  },

  resetSession(sessionId, messages) {
    resetSessionSpend();
    set({
      sessionId,
      messages,
      sessionCost: 0,
      sessionPromptTokens: 0,
      sessionCompletionTokens: 0,
      sessionCachedTokens: 0,
      sessionCacheWriteTokens: 0,
      sessionCostEstimated: false,
      sessionUsageBySource: {},
      lastContextTokens: 0,
      userMessageCount: 0,
      plan: null,
      lastSummary: null,
      pastedImages: [],
    });
  },

  setProfile(profile) {
    set({ profile });
  },

  setPlan(plan) {
    set({ plan });
  },

  setLastSummary(lastSummary) {
    set({ lastSummary });
  },
});
