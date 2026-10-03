// Extract key facts from messages being compressed
// Uses the same OpenRouter API with a cheap/fast model

import { stripTimeStamp } from "../agent/time-stamp.js";
import { config } from "../config.js";
import { chatCompletion } from "../api/client.js";

const EXTRACTION_PROMPT = `You are a fact extractor. Given a conversation fragment, extract KEY FACTS that should be remembered.

Rules:
- Extract only important, reusable facts (not chit-chat)
- Categories: project (project details), tech (technologies, versions), decision (decisions made), preference (user preferences), bug (bugs found), person (people mentioned), env (environment details)
- Each fact = one short sentence in the SAME language as the conversation
- Max 10 facts per fragment
- Skip trivial things (greetings, confirmations, "ok", "done")
- If nothing important — return empty array

Return ONLY valid JSON array:
[{"content": "fact text", "category": "tech"}, ...]`;

// Use a fast cheap model for extraction — don't waste main model tokens
const EXTRACTION_MODEL = config.extractionModel;

export async function extractFacts(messages) {
  if (!messages?.length) return [];

  // Build a text representation of messages to analyze
  const fragments = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "user") {
      const text = typeof m.content === "string" ? stripTimeStamp(m.content) : "[multimodal]";
      fragments.push(`User: ${text}`);
    } else if (m.role === "assistant") {
      const text = m.content || "";
      if (m.tool_calls?.length) {
        for (const tc of m.tool_calls) {
          fragments.push(`Agent called: ${tc.function.name}(${tc.function.arguments?.slice(0, 200)})`);
        }
      }
      if (text) fragments.push(`Agent: ${text.slice(0, 500)}`);
    } else if (m.role === "tool") {
      const preview = (m.content || "").slice(0, 300);
      fragments.push(`Tool ${m._toolName || "?"}: ${preview}`);
    }
  }

  if (!fragments.length) return [];

  // Limit to ~4000 chars to keep extraction cheap
  const conversationText = fragments.join("\n").slice(0, 4000);

  try {
    // Through the one door to the provider. agent.js fires this per user message,
    // fire-and-forget, so a late reply lands in the NEXT turn's drain rather
    // than this one's. That is a lag in the session total, not a hole in it; a
    // reply that arrives after the run ends is lost, which is why the number
    // can still be a shade low.
    //
    // The door refuses when the budget is spent, and that refusal arrives here
    // as a throw, which the catch below turns into "no facts this time". A
    // memory that skips a fragment is a smaller problem than a memory that
    // spends past the ceiling the operator set.
    const { message } = await chatCompletion(
      [
        { role: "system", content: EXTRACTION_PROMPT },
        { role: "user", content: conversationText },
      ],
      [],
      null,
      {
        source: "facts",
        model: EXTRACTION_MODEL,
        maxTokens: 1024,
        temperature: 0,
        stream: false,
      },
    );
    const text = message?.content || "";

    // Parse JSON from response (handle markdown code blocks)
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];

    const facts = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(facts)) return [];

    // Validate and clean
    return facts
      .filter((f) => f.content && typeof f.content === "string" && f.content.length > 3)
      .map((f) => ({
        content: f.content.slice(0, 500),
        category: f.category || "auto",
      }));
  } catch {
    return [];
  }
}
