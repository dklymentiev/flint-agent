import chalk from "chalk";
import { readFileSync } from "node:fs";

// The FLiNT mark (owner, 2026-10-02), after the designer's wordmark: an F
// whose top bar stands apart, titanium letters, one yellow spark over the i, the
// version beside it. It replaced the -[°^°]- mascot. Two text rows of half
// blocks, so it renders in any monospace font.
export const MARK = [
  "▀▀▀ █   ▀ █▄ █ ▀█▀",
  "█▀▀ █▄▄ █ █ ▀█  █",
];
const MARK_ACCENT = [[8], []]; // column of the dot over the i, per row

// 256-colour codes, the same the launcher's loading line uses, so the mark
// does not change colour between loading and the header: titanium 250,
// spark yellow 220, grey 244. Yellow, not orange (owner and designer,
// 2026-10-02): warm orange is Claude Code's colour.
const SPARK = 220;
const TITANIUM = 250;
const DIM = 244;

/** The mark's two rows, coloured; `tail` goes after the second row. */
export function markLines(tail = "") {
  return MARK.map((row, r) => {
    let s = "";
    for (let i = 0; i < row.length; i++) {
      s += MARK_ACCENT[r].includes(i) ? chalk.ansi256(SPARK)(row[i]) : chalk.ansi256(TITANIUM)(row[i]);
    }
    return " " + s + (r === MARK.length - 1 && tail ? "   " + tail : "");
  });
}

export function printSplash(version = "0.0.0", returnString = false) {
  const lines = markLines(chalk.ansi256(DIM)(`v${version}`));
  if (returnString) return lines.join("\n");
  console.log("");
  for (const l of lines) console.log(l);
  console.log("");
}

if (process.argv[1]?.endsWith("splash.js")) {
  // When run directly (node src/ui/splash.js), read the live version
  // from package.json — previously hardcoded "0.9.3" which decayed.
  let version = "0.0.0";
  try {
    version = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf-8")).version;
  } catch {}
  printSplash(version);
}
