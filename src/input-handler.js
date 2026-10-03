// Lock utility for serializing command execution (e.g. /paste, /auto, /new)
// Message processing goes through bus drain loop (src/bus/drain-loop.js)
import { app } from "./app-state.js";

export function withLock(fn) {
  const prev = app.lockChain;
  let unlock;
  app.lockChain = new Promise((r) => (unlock = r));
  return prev.then(() => {
    if (app.queueAborted) return;
    return fn();
  }).finally(unlock);
}
