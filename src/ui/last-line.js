// The last thing a command printed, as one readable line.
//
// Owner, 2026-10-01: a long foreground run_command (a scan, a build) showed
// only its command and a clock until it finished. Its latest output line is
// shown on the activity row instead (see run_command in tools/process-tools.js).

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)/g;

/**
 * Last non-empty line of a chunk of output, or null.
 * Progress bars redraw with \r, so only the text after the last \r counts.
 */
export function lastOutputLine(chunk) {
  const text = String(chunk ?? "").replace(ANSI, "");
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const parts = lines[i].split("\r");
    const shown = parts[parts.length - 1] || parts.filter((p) => p.trim()).pop() || "";
    // eslint-disable-next-line no-control-regex
    const clean = shown.replace(/[\x00-\x1f\x7f]/g, "").replace(/\s+/g, " ").trim();
    if (clean) return clean;
  }
  return null;
}
