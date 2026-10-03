// Which of the three things happened on a turn that changed nothing.
//
// A turn that changed nothing must tell the operator WHICH: the agent did not find what to
// change, or found it and could not apply the change, or there was nothing to
// change. Only the model that did the turn can say, so it is asked.
//
// It used to be asked inside the conversation: a [OUTCOME] system message, then
// `continue`, and the loop took the next reply as the turn's answer. The
// question says "in one sentence", the model obeys, and the one sentence
// REPLACED the answer. Measured on ten readiness probes, 2026-09-21: eight
// turns of ten came back to the operator as a single sentence about change,
// their actual answer lost inside the loop. cut-0003 asked "go to the server",
// ran a command, and the whole answer was "The request was not asking for a
// change."
//
// So the question is not a turn of the conversation. It is one small call of
// its own, like the classifier, and its answer is a line of explanation, never
// the answer itself. That also makes it cheaper: the in-conversation ask
// re-sent the whole context and the tool schemas, around 9k prompt tokens on
// the measured run; this sends the evidence and nothing else.

import { config } from "../config.js";
import { chatCompletion } from "../api/client.js";
import { createLogger } from "../logging/logger.js";

const log = createLogger("outcome-ask");

const SYSTEM = `You are reporting on one turn of an agent that finished without changing any file on disk.

Say, in ONE short sentence addressed to the operator, which of these is true:
- you did not find what to change;
- you found what to change but did not apply the change;
- there was nothing to change;
- the request was not asking for a change.

Reply with that sentence and nothing else. No preamble, no JSON, no quotes.`;

/**
 * Ask why the turn changed nothing.
 *
 * @param {object} turn
 * @param {string} turn.request   what the user asked for
 * @param {string} turn.answer    what the agent replied
 * @param {string[]} turn.tools   names of the tools the turn called, in order
 * @param {AbortSignal} [turn.signal]
 * @returns {Promise<string|null>} one sentence, or null when the call did not happen
 */
export async function askOutcome({ request, answer, tools = [], signal }) {
  if (!config.apiKey) return null;

  const evidence = [
    `REQUEST: ${String(request || "").slice(0, 1500)}`,
    `YOUR ANSWER: ${String(answer || "").slice(0, 1500)}`,
    `TOOLS YOU CALLED: ${tools.length ? tools.join(", ") : "(none)"}`,
    "NOTHING ON DISK CHANGED.",
  ].join("\n\n");

  try {
    const { message } = await chatCompletion(
      [
        { role: "system", content: SYSTEM },
        { role: "user", content: evidence },
      ],
      [],
      null,
      {
        source: "outcome",
        model: config.model,
        maxTokens: 80,
        temperature: 0,
        stream: false,
        signal,
        // A ceiling of its own, always: the turn's signal cancels the ask when
        // the user aborts, but it never expires on its own, and a hung reason
        // must not hold back the answer that is already written.
        timeoutMs: 15000,
      },
    );
    const text = (message?.content || "").trim();
    if (!text) return null;
    // One sentence is what was asked for; a model that writes three gets cut,
    // because this line sits next to the answer and must not compete with it.
    return text.split("\n")[0].slice(0, 300);
  } catch (err) {
    // The reason is best effort. The FACT that nothing changed is not: the
    // caller states that either way. Losing the
    // reason must never cost the operator the fact.
    log.warn("outcome-ask failed", { error: err.message });
    return null;
  }
}
