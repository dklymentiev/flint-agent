import { appendFileSync } from "node:fs";
import { config } from "../config.js";
import path from "node:path";

export function logApiCall(sessionId, callNum, messages, tools, reply, usage) {
  if (!sessionId) return;
  const file = path.join(config.sessionsDir, `${sessionId}.api.log`);
  const ts = new Date().toISOString().slice(11, 19);

  try {
    if (messages) {
      const sep = "=".repeat(60);
      let totalChars = 0;
      const lines = [];

      for (let i = 0; i < messages.length; i++) {
        const m = messages[i];
        const contentLen = (m.content || "").length;
        totalChars += contentLen;

        let desc = `  [${i}] ${m.role}: ${contentLen} chars`;
        if (m.role === "assistant" && m.tool_calls?.length) {
          const toolNames = m.tool_calls.map((tc) => tc.function?.name || "?").join(", ");
          desc += ` + tools=[${toolNames}]`;
        }
        if (m.role === "tool") {
          const name = m._toolName || "?";
          desc += ` (${name})`;
          if (m._compressed) desc += ` [${m._compressed}]`;
        }
        lines.push(desc);
      }

      const toolCount = tools?.length || 0;
      const header = [
        `${sep}`,
        `[${ts}] API Call #${callNum}`,
        `${sep}`,
        `Messages: ${messages.length} (${totalChars} chars total content)`,
        `Tools: ${toolCount} definitions`,
      ].join("\n");

      appendFileSync(file, `${header}\n${lines.join("\n")}\n`);

      // Full message dump: write complete content for prompt analysis
      const rawFile = path.join(config.sessionsDir, `${sessionId}.messages.jsonl`);
      try {
        const entry = {
          ts, callNum,
          messages: messages.map(m => ({
            role: m.role,
            content: m.content || "",
            tool_calls: m.tool_calls,
            tool_call_id: m.tool_call_id,
          })),
          toolCount,
        };
        appendFileSync(rawFile, JSON.stringify(entry) + "\n");
      } catch {}
    }

    if (reply) {
      const contentLen = (reply.content || "").length;
      const toolCalls = reply.tool_calls || [];
      let toolDesc = "none";
      if (toolCalls.length) {
        toolDesc = toolCalls
          .map((tc) => {
            const name = tc.function?.name || "?";
            let argsShort = "";
            try {
              const parsed = JSON.parse(tc.function?.arguments || "{}");
              argsShort = Object.entries(parsed)
                .map(([k, v]) => {
                  const s = typeof v === "string" && v.length > 60 ? v.slice(0, 60) + "..." : String(v);
                  return `${k}="${s}"`;
                })
                .join(", ");
            } catch {}
            return `${name}(${argsShort})`;
          })
          .join("; ");
      }

      const usageStr = usage
        ? `prompt=${usage.prompt_tokens || 0} completion=${usage.completion_tokens || 0} total=${(usage.prompt_tokens || 0) + (usage.completion_tokens || 0)}`
        : "n/a";

      appendFileSync(
        file,
        `Response: ${contentLen} chars, tool_calls: ${toolDesc}\nUsage: ${usageStr}\n\n`,
      );
    }
  } catch {}
}
