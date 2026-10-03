import { createStore } from "zustand/vanilla";
import { createSessionSlice } from "../../src/store/session-slice.js";
import { createAgentSlice } from "../../src/store/agent-slice.js";
import { createUiSlice } from "../../src/store/ui-slice.js";
import { createProcessSlice } from "../../src/store/process-slice.js";
import { createDatasetSlice } from "../../src/store/dataset-slice.js";

export function createMockStore(overrides = {}) {
  const store = createStore((...args) => ({
    ...createSessionSlice(...args),
    ...createAgentSlice(...args),
    ...createUiSlice(...args),
    ...createProcessSlice(...args),
    ...createDatasetSlice(...args),
    ...overrides,
  }));
  return store;
}
