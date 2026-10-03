// When a child agent counts as idle, for its idle timeout (index.js).
//
// The timeout was reset only when the store's message count changed, and a
// turn writes its messages back at the end. A child given a research task
// shut itself down one minute in, between two browser calls, with nothing
// written (2026-10-02, agent@3010). Working is not idle.

/** A turn, queued work, or a stoppable task in flight: not idle. */
export function childBusy({ processing, processingCount, agentStatus, abortController } = {}) {
  return !!processing
    || (processingCount || 0) > 0
    || (!!agentStatus && agentStatus !== "idle")
    || !!abortController;
}
