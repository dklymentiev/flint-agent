// Tool calls the model wrote as text.
//
// On 2026-09-29 a turn classified `chat` (0 tools, 1 step) had the model write
// its tool calls into the answer:
//
//   <tool_call><function=edit_file>... 9 KB of it ...
//
// Nothing ran it. The text streamed to the console as if it were progress, the
// operator saw nine kilobytes of a diff scroll past, and the only thing that
// recovered the session was /new.
//
// Two things were wrong with that, and they are separate:
//
//   1. The text was printed as progress. Whatever the model meant, a turn that
//      cannot run what it wrote must not LOOK like it ran it.
//   2. Nothing said so. The answer came back as `done`, and a task that
//      changed nothing reads exactly like a task that finished.
//
// So: find the calls, and either Flint can run them or the operator is told
// that the model answered in a form Flint could not run. Never neither.

// One model puts a zero-width space inside the tag so that markdown renderers
// leave it alone. It is written as an escape here rather than as the character,
// because a literal invisible character inside a regex is unreadable and gets
// eaten by every editor that reformats a file.
const ZW = "\\u200b";

// No `g` on the two detectors. With it, `.test()` advances `lastIndex` and the
// next call starts mid-string, so the same answer is detected on one call and
// missed on the next -- a detector that alternates is worse than none. The
// scanning regexes keep `g` because they are always used with matchAll, which
// does not share that state.
const TOOL_CALL_TAG = new RegExp(`<\\s*${ZW}?\\s*tool_call\\s*>`, "i");
// Two shapes need the same pattern matched two ways, and the difference is
// not cosmetic: String.match() with a `g` flag returns the full matches and
// throws the capture groups away, so `fn[1]` — the tool name — comes back
// undefined. A scan regex and a single-match regex, both built from one source.
const FUNCTION_SRC = `<\\s*${ZW}?\\s*function\\s*=\\s*([A-Za-z0-9_.-]+)\\s*>`;
const FUNCTION_TAG = new RegExp(FUNCTION_SRC, "gi");   // matchAll
const FUNCTION_ONE = new RegExp(FUNCTION_SRC, "i");    // .match(), keeps groups
const FUNCTION_OPEN = new RegExp(`<\\s*${ZW}?\\s*function\\s*=`, "i");
// The closing tag carries the same zero-width character as the opening one, so
// it has to be built the same way. Without this the body ran to end-of-answer
// and every JSON-body call came back truncated — which the "unreadable" branch
// reported honestly, but the tool name was lost with it.
const CLOSE_TAG = new RegExp(`<\\s*${ZW}?\\s*\\/\\s*(?:tool_call|function)\\s*>`, "i");

/**
 * Does this text contain a tool call written as text?
 *
 * Cheap and prefix-friendly, so it can be run on a growing stream buffer: it
 * answers "has this started?", not "is it complete?".
 *
 * @param {string} text
 * @returns {boolean}
 */
export function looksLikeTextToolCall(text) {
  const s = String(text || "");
  if (!s) return false;
  return TOOL_CALL_TAG.test(s) || FUNCTION_OPEN.test(s);
}

/**
 * Pull the tool calls out of an answer that wrote them as text.
 *
 * Both shapes seen in the wild:
 *   <tool_call><function=edit_file>{"path":"a.js"}</tool_call>   (function tag)
 *   <tool_call>{"name":"edit_file","arguments":{...}}</tool_call>  (JSON body)
 *
 * Arguments are reported as the raw text that followed the name: Flint does not
 * run them (they may be truncated mid-JSON by the model's own output limits),
 * and a half-written argument string is exactly what the operator needs to see
 * named as unrunnable rather than silently dropped.
 *
 * @param {string} text
 * @returns {Array<{name: string, args: string}>} possibly empty
 */
export function findTextToolCalls(text) {
  const s = String(text || "");
  if (!looksLikeTextToolCall(s)) return [];

  const calls = [];
  // One pass over the opening tags, not one pass per shape.
  //
  // The two shapes nest: `<tool_call><function=edit_file>{...}</tool_call>`
  // is a tool_call whose body is a function tag. Scanning for both
  // independently counts it twice, and a greedy body scan then swallows the
  // NEXT call, so the second one comes back as "unreadable". Both shapes were
  // counted wrong before this: one call reported as two, then two reported as
  // one good and one unreadable.
  // matchAll requires the g flag, so the scan gets its own copy rather than
  // the detector being reused with state attached to it.
  const OPEN_SCAN = new RegExp(TOOL_CALL_TAG.source, "gi");
  OPEN_SCAN.lastIndex = 0;
  for (const open of s.matchAll(OPEN_SCAN)) {
    const rest = s.slice(open.index + open[0].length);
    const close = rest.search(CLOSE_TAG);
    // No closing tag means the model was cut off mid-call. The rest of the
    // answer IS the body, which is the 9 KB case.
    const body = (close === -1 ? rest : rest.slice(0, close)).trim();

    // Shape A: a function tag, with the name in the tag.
    const fn = body.match(FUNCTION_ONE);
    if (fn) {
      const after = body.slice(body.indexOf(fn[0]) + fn[0].length);
      const inner = after.trim();
      calls.push({ name: fn[1], args: inner || "" });
      continue;
    }

    // Shape B: a JSON body carrying its own name.
    if (!body) {
      // The tag opened and the model stopped before writing anything.
      calls.push({ name: "(unreadable)", args: "" });
      continue;
    }
    const brace = body.indexOf("{");
    const json = brace === -1 ? body : body.slice(brace);
    try {
      const parsed = JSON.parse(json);
      const name = parsed.name || parsed.function?.name || parsed.tool;
      calls.push({
        name: name ? String(name) : "(unreadable)",
        args: JSON.stringify(parsed.arguments ?? parsed.args ?? {}),
      });
    } catch {
      calls.push({ name: "(unreadable)", args: json.slice(0, 200) });
    }
  }

  // A function tag with no enclosing tool_call, which is the shape seen in the
  // logs with the outer tag missing.
  if (calls.length === 0) {
    FUNCTION_TAG.lastIndex = 0;
    for (const m of s.matchAll(FUNCTION_TAG)) {
      const rest = s.slice(m.index + m[0].length);
      const close = rest.search(CLOSE_TAG);
      calls.push({ name: m[1], args: (close === -1 ? rest : rest.slice(0, close)).trim() });
    }
  }

  return calls;
}

/**
 * What the operator is told when the model wrote tool calls as text.
 *
 * Says what Flint could not run and what to do, and never says the work was
 * done. Short on purpose: this line replaces nine kilobytes of text nobody can
 * act on.
 *
 * @param {Array<{name: string, args: string}>} calls
 * @param {object} [opts] - { attempts?: number }
 * @returns {string}
 */
export function toolCallTextNote(calls, { attempts = 0 } = {}) {
  const names = [...new Set((calls || []).map((c) => c.name))];
  const list = names.length ? names.join(", ") : "(no name readable)";
  const again = attempts > 0 ? ` It wrote it as text ${attempts + 1} times in a row.` : "";
  return `Stopped: the model wrote its tool call as text instead of calling the tool, so nothing ran. ` +
    `Tool(s) written as text: ${list}. This answer did no work: read it, then tell me what to carry out.${again}`;
}