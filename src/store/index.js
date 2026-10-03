import { createStore } from "zustand/vanilla";
import { createSessionSlice } from "./session-slice.js";
import { createAgentSlice } from "./agent-slice.js";
import { createUiSlice } from "./ui-slice.js";
import { createProcessSlice } from "./process-slice.js";
import { createDatasetSlice } from "./dataset-slice.js";

export const store = createStore((...args) => ({
  ...createSessionSlice(...args),
  ...createAgentSlice(...args),
  ...createUiSlice(...args),
  ...createProcessSlice(...args),
  ...createDatasetSlice(...args),
}));

// Convenience: useStore hook for React components
// Usage: const lines = useStore(s => s.lines)
export function useStore(selector) {
  // This is implemented in the React layer — see components/App.js
  // For vanilla (non-React) access, use store.getState() and store.subscribe()
  throw new Error("useStore must be used within React — use store.getState() outside React");
}
