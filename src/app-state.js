// Shared mutable application state.
// All modules import this object and read/write its properties directly.

import { config } from "./config.js";

export const app = {
  abortController: null,
  systemMessage: null,
  activeProfile: "generic",
  profileConfig: null,
  mcpStatusList: [],
  actualPort: 3000,
  securityApi: null,
  inkInstance: null,
  shuttingDown: false,
  lockChain: Promise.resolve(),
  queueAborted: false,
  autonomous: false, // autonomous mode: self-continue when plan has pending tasks
  apiGoalId: null, // goal ID created by current API task — stop when this goal completes
};

// Session data snapshot -- used by multiple modules for saving
// Must be called with store as argument to avoid circular imports
export function sessionData(store) {
  const ss = store.getState();
  return {
    messages: ss.messages,
    model: config.model,
    provider: config.provider,
    profile: app.activeProfile,
    plan: ss.plan,
    inputHistory: ss.inputHistory,
    pastedImages: ss.pastedImages,
    lastSummary: ss.lastSummary,
    sessionCost: ss.sessionCost,
    sessionPromptTokens: ss.sessionPromptTokens,
    sessionCompletionTokens: ss.sessionCompletionTokens,
  };
}
