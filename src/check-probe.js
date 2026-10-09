// The --check probe, as a function.
//
// Three questions, answered in seconds and a fraction of a cent: is there a
// key, does the model answer, does a tool call go out and come back. Not
// inline in index.js for the usual reason: importing index.js starts a
// session, so a test of code written there tests a copy.
//
// The prompt and the definition of "right answer" are the run-command entry of
// CHECK_TASKS (model-check.js), so the probe and the model check agree.

/** Exit codes of `flint --check`. */
export const CHECK_OK = 0;
export const CHECK_NO_KEY = 10;
export const CHECK_NO_ANSWER = 11;
export const CHECK_NO_ROUND_TRIP = 12;

// The names a model may give its command tool (permissions.js maps the
// synonyms to run_command).
const COMMAND_TOOL = /run_command|run_background|exec|shell|bash/;

function parseArguments(raw) {
  if (raw && typeof raw === "object") return raw;
  try { return JSON.parse(raw || "{}"); } catch { return {}; }
}

/**
 * @param {object} o
 * @param {{ prompt: string, check: (r: {dir: string, answer: string, tools: object[]}) => boolean }} o.task
 * @param {boolean} o.hasKey
 * @param {(messages: object[]) => Promise<object>} o.chat - one model call, with the command tools offered
 * @param {(name: string, args: object) => Promise<{content: string, denied: boolean}>} o.runTool
 *   The path a tool call takes in a normal run, with nobody there to approve
 *   (permissions.js executeToolWithPermissions, unattended). The command comes
 *   from the model: it used to be handed to execSync as it was, past the
 *   permission rules, the command guard and the sandbox, on the machine of
 *   whoever ran a check.
 * @param {string} o.dir - where the probe runs
 * @param {string} o.provider
 * @param {string} o.model
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
export async function runCheckProbe({ task, hasKey, chat, runTool, dir, provider, model }) {
  if (!hasKey) {
    return {
      code: CHECK_NO_KEY,
      stdout: "",
      stderr: "[check] No API key is configured. Pass it in the environment " +
        "(for example OPENROUTER_API_KEY or OPENAI_API_KEY) and start again.\n",
    };
  }

  const messages = [{ role: "user", content: task.prompt }];
  let reply;
  try {
    reply = await chat(messages);
  } catch (err) {
    return {
      code: CHECK_NO_ANSWER,
      stdout: "check failed: model did not answer\n",
      stderr: `[check] Model did not answer: ${err.message}\n`,
    };
  }

  const msg = reply?.message || reply || {};
  const rawCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
  const calls = rawCalls.map((t, i) => ({
    // An id the provider left out still has to pair the call with its answer.
    id: t.id || `call_${i + 1}`,
    name: t.function?.name || t.name || "",
    is_error: t.is_error || false,
    arguments: parseArguments(t.function?.arguments ?? t.arguments),
  }));
  const isCommand = (c) => !c.is_error && COMMAND_TOOL.test(c.name);

  if (!calls.some(isCommand)) {
    // The model answered in words. That is an answer (so not 11), and it
    // proves nothing about the tool pipeline.
    return {
      code: CHECK_NO_ROUND_TRIP,
      stdout: `check failed: model answered ("${String(msg.content || "").slice(0, 80)}") but no tool call round-tripped\n`,
      stderr: "",
    };
  }

  // Every tool call gets its own answer, under its own id. Only the first one
  // used to be answered: with two calls in the reply the provider rejected the
  // next request (400, a tool call without a response) and the probe said the
  // model had not answered.
  messages.push(calls.length === rawCalls.length && rawCalls.every((t) => t.id)
    ? msg
    : { ...msg, tool_calls: rawCalls.map((t, i) => ({ ...t, id: calls[i].id })) });
  let ran = 0;
  let refusal = "";
  for (const call of calls) {
    let content;
    if (!isCommand(call)) {
      content = `Tool "${call.name}" was not run: this check runs one command and nothing else.`;
    } else {
      // The probe's command is `command`; `argument` is what some models call it.
      const args = call.arguments.command || !call.arguments.argument
        ? call.arguments
        : { ...call.arguments, command: call.arguments.argument };
      try {
        const res = await runTool(call.name, args);
        content = String(res.content ?? "");
        if (res.denied) refusal ||= content; else ran++;
      } catch (err) {
        content = `error: ${err.message}`;
        ran++;
      }
    }
    messages.push({ role: "tool", tool_call_id: call.id, content: content.trim() });
  }

  if (ran === 0) {
    // Nothing ran, so there is no round trip to ask the model about, and no
    // reason to pay for a second call.
    return {
      code: CHECK_NO_ROUND_TRIP,
      stdout: `check failed: the command was refused and not run (${refusal.slice(0, 200)})\n`,
      stderr: "[check] The model's command did not pass the permission check of an unattended run.\n",
    };
  }

  try {
    reply = await chat(messages);
  } catch (err) {
    return {
      code: CHECK_NO_ANSWER,
      stdout: "check failed: model did not answer after tool result\n",
      stderr: `[check] Model did not answer after tool result: ${err.message}\n`,
    };
  }

  const answer = String((reply?.message || reply || {}).content || "");
  if (!task.check({ dir, answer, tools: calls })) {
    return {
      code: CHECK_NO_ROUND_TRIP,
      stdout: `check failed: tool round-trip failed (answer="${answer.slice(0, 80)}")\n`,
      stderr: "[check] Tool call did not round-trip or answer was wrong.\n",
    };
  }
  return { code: CHECK_OK, stdout: `check ok: key=${provider} model=${model} tool=round-trip\n`, stderr: "" };
}
