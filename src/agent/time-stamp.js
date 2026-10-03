// The local date and time at the start of each message the operator sends.
//
// Owner, 2026-10-02: a research session wrote "Compiled 2026-09-30" into
// four documents on 2026-10-02. The clock is kept out of the system prompt on
// purpose (a line that moved every minute at the top of the prompt cost the
// cache everything after it, 2.3x on a benchmark), and system.md asked the
// agent to run `date` when it needed the time; it took a date from the
// articles it had read instead.
//
// Here the time goes into the new message, at the end of the conversation,
// which is never cached anyway; everything before it is unchanged. It is
// written once, when the message is added to the history, so every later call
// of the turn and every later turn sends the same bytes. Nothing on screen
// shows it.

const STAMP_RE = /^\[Local time: [^\]\n]*\]\n?/;

/** "[Local time: Fri 2026-10-02 10:16 CDT, UTC-05:00]" for the given moment. */
export function messageTimeStamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  const day = date.toLocaleDateString("en-US", { weekday: "short" });
  const ymd = `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
  const hm = `${p(date.getHours())}:${p(date.getMinutes())}`;
  let zone = "";
  try {
    zone = new Intl.DateTimeFormat("en-US", { timeZoneName: "short" })
      .formatToParts(date).find((x) => x.type === "timeZoneName")?.value || "";
  } catch {}
  const off = -date.getTimezoneOffset();
  const utc = `UTC${off >= 0 ? "+" : "-"}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`;
  return `[Local time: ${day} ${ymd} ${hm}${zone ? ` ${zone}` : ""}, ${utc}]`;
}

/**
 * The message content with the stamp in front: a string gets a first line, a
 * list of parts gets a first text part.
 */
export function withTimeStamp(content, date = new Date()) {
  const stamp = messageTimeStamp(date);
  if (typeof content === "string") return `${stamp}\n${content}`;
  if (Array.isArray(content)) return [{ type: "text", text: stamp }, ...content];
  return content;
}

/** The text without a leading stamp, for showing a message back to a person. */
export function stripTimeStamp(text) {
  return typeof text === "string" ? text.replace(STAMP_RE, "") : text;
}
