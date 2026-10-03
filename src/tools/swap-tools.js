// swap_list and swap_read: what the session's context swap holds, and reading
// it back (docs/context-swap.md). The store is the current session's
// (agent/swap.js getCurrentSwapStore), handed in so the tools test alone.

import { stubFor } from "../agent/swap.js";

export const swapToolDefs = [
  {
    type: "function",
    function: {
      name: "swap_list",
      description:
        "List what this session has moved out of the context to its swap: pages, files and command output " +
        "read earlier, newest first, one line each ([swap #N ...]). Filter by turn, by time ('1h', '30m'), " +
        "by a part of the source (URL, path, command) or by words in the title. Look here before fetching " +
        "something again.",
      parameters: {
        type: "object",
        properties: {
          turn: { type: "number", description: "Only entries from this turn" },
          since: { type: "string", description: "Only entries newer than this, e.g. '1h', '30m', '2d'" },
          source: { type: "string", description: "Part of the URL, path or command" },
          text: { type: "string", description: "Words that must all be in the title" },
          limit: { type: "number", description: "At most this many (default 30)" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "swap_read",
      description:
        "Read back a swapped entry by its number (the N of [swap #N ...]): all of it, or `limit` lines " +
        "from line `offset` for a long one. To search inside swapped text, use search_in_files on the " +
        "session's swap folder.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "number", description: "The entry number" },
          offset: { type: "number", description: "First line to read, from 1" },
          limit: { type: "number", description: "How many lines" },
        },
        required: ["id"],
      },
    },
  },
];

const UNAVAILABLE = "Swap is not available in this session.";

export function createSwapHandlers(getStore) {
  return {
    async swap_list({ turn, since, source, text, limit = 30 } = {}) {
      const store = getStore();
      if (!store) return UNAVAILABLE;
      const entries = store.list({ turn, since, source, text, limit });
      if (!entries.length) return "Nothing in swap matches.";
      return `${entries.length} swapped entr${entries.length === 1 ? "y" : "ies"}, newest first (folder: ${store.dir}):\n` +
        entries.map(stubFor).join("\n");
    },
    async swap_read({ id, offset, limit } = {}) {
      const store = getStore();
      if (!store) return UNAVAILABLE;
      const e = store.get(id);
      if (!e) return `No swap entry #${id}. swap_list shows what there is.`;
      const text = store.read(id, { offset, limit });
      if (text == null) return `Swap entry #${id} is listed but its file could not be read (${e.file}).`;
      return `${stubFor(e)}\n${text}`;
    },
  };
}
