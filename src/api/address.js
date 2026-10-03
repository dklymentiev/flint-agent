// Where Flint's HTTP API listens, and the URL every caller uses to reach it.
//
// One address for both sides (2026-10-02). The server binds 127.0.0.1 only,
// while the callers (a parent asking its child agents, the agent registry,
// the orphan check) fetched http://localhost. On Node 22, which Flint needs,
// `localhost` resolves to ::1 first and nothing listens there, so every one of
// those calls failed with ECONNREFUSED; GitHub's Windows runners showed it.

export const API_HOST = "127.0.0.1";

/** http://127.0.0.1:<port><path> */
export function apiUrl(port, path = "") {
  return `http://${API_HOST}:${port}${path}`;
}
