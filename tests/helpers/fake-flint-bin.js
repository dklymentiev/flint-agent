// A stand-in for bin/flint.js in the model-check tests: speaks the stdio
// stream-json protocol with no model behind it, so cold start, stderr noise
// and provider verdicts can be staged exactly. Behaviour comes from env:
//   FAKE_INIT_DELAY_MS   wait this long before the init event (slow cold start)
//   FAKE_NEVER_INIT      never print init
//   FAKE_STDERR_LINE     print this line on stderr after init (unrelated noise)
//   FAKE_PROVIDER_ERROR  JSON for the result's provider_error field
//   FAKE_LOG             file; one line per user turn: how many turns this process has seen
import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";

const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const delay = parseInt(process.env.FAKE_INIT_DELAY_MS || "0", 10);

setTimeout(() => {
  if (process.env.FAKE_NEVER_INIT) return;
  out({ type: "system", subtype: "init", session_id: "fake", model: "fake", tools: [] });
  if (process.env.FAKE_STDERR_LINE) process.stderr.write(process.env.FAKE_STDERR_LINE + "\n");
}, delay);

let turns = 0;
const rl = createInterface({ input: process.stdin });
rl.on("line", (l) => {
  let m; try { m = JSON.parse(l); } catch { return; }
  if (m.type !== "user") return;
  turns++;
  if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, `${turns}\n`);
  const pe = process.env.FAKE_PROVIDER_ERROR ? JSON.parse(process.env.FAKE_PROVIDER_ERROR) : null;
  out({
    type: "result", subtype: pe ? "error_during_execution" : "success", is_error: !!pe,
    result: pe ? "Error" : "ready", usage: { input_tokens: 100 * turns, output_tokens: 5 },
    ...(pe ? { provider_error: pe } : {}),
  });
});
rl.on("close", () => process.exit(0));
