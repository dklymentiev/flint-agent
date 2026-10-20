// Ask the operator for a provider's API key and keep it (encrypted).
//
// The key is read through the app's own input box in secret mode, NOT
// through a second readline on stdin. Owner, 2026-10-01: readline and the Ink
// input both received the pasted line; readline saved the key and the Ink
// input submitted it as a chat message, so the key was sent to the model and
// written to the session log. Secret mode masks the text and hands it only to
// this resolver (see App.js).
//
// /key asks with it, and so does picking a provider that has no key yet
// (owner, 2026-10-19: "чтобы ключ сразу спрашивал"), from the list or by name.

import { setKey } from "./keys.js";

/** True when a key was entered and saved; false when the operator left it empty. */
export async function askForKey(store, provider, log) {
  log(`  Enter API key for ${provider.name}:`);
  log("  (paste key and press Enter; empty cancels)");
  const key = await new Promise((resolve) => {
    store.setState({ secretPrompt: { label: `${provider.name} API key`, resolve } });
  });
  const trimmed = String(key || "").trim();
  if (!trimmed) {
    log("  Cancelled.");
    return false;
  }
  await setKey(provider.id, trimmed);
  log(`  Key saved for ${provider.name} (encrypted).`);
  return true;
}
