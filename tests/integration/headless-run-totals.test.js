// The headless result record covers the whole run, on one basis.
//
// When auto-verify sends a second message, the record used to take cost and
// tokens from that second turn only, while tool_calls and denied_calls were
// session totals: the money of the first turn was missing from a JSON whose
// other numbers included it. The fake provider bills every request the same
// (helpers/headless-fake.js USAGE), so the expected totals are the request
// count times that price.
//
// Second case: started from a folder without --cwd, modified_files must list
// that folder's changes. The launcher runs Flint's process from the install
// folder, so `git status` with no cwd reported the Flint checkout instead.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { startFakeProvider, runHeadless, intent, toolCall, USAGE } from "../helpers/headless-fake.js";

const VERIFY = "Your previous edit produced NO changes";

describe("--headless: one record for the whole run", () => {
  it("cost and tokens include the turn before the auto-verify retry", async () => {
    const provider = await startFakeProvider((body, isStreaming) => {
      if (!isStreaming) return intent(["edit_file"], 3);
      const messages = body?.messages || [];
      const last = messages[messages.length - 1];
      if (typeof last?.content === "string" && last.content.includes(VERIFY)) {
        return { streamingParts: [{ content: "The edit failed." }] };
      }
      if (messages.some((m) => m.role === "tool")) {
        return { streamingParts: [{ content: "I could not find the text." }] };
      }
      return toolCall("edit_file", { path: "nonexistent.txt", old_text: "not there", new_text: "x" });
    });
    try {
      const { code, result, stderr } = await runHeadless({ task: "edit the nonexistent file", providerPort: provider.port });
      const n = provider.getRequestCount();
      expect(provider.getBodies().some((b) => JSON.stringify(b).includes(VERIFY)), "the retry turn must have run").toBe(true);
      expect(code, stderr.slice(-400)).toBe(0);
      expect(result.stop_reason).toBe("done");

      // Every request the run made is in the record: both turns.
      expect(result.tokens).toBe(n * (USAGE.prompt_tokens + USAGE.completion_tokens));
      expect(result.tokens_obj.prompt).toBe(n * USAGE.prompt_tokens);
      expect(result.tokens_obj.completion).toBe(n * USAGE.completion_tokens);
      expect(result.cost).toBeCloseTo(n * USAGE.cost, 9);
      // And the tool call of the first turn is counted next to them.
      expect(result.tool_calls).toBe(1);

      // The documented name only (docs/headless-mode.md).
      expect(result).toHaveProperty("modified_files");
      expect(result).not.toHaveProperty("modifiedFiles");
    } finally {
      provider.close();
    }
  }, 60000);

  it("without --cwd, modified_files is the folder Flint was started from", async () => {
    const provider = await startFakeProvider((body, isStreaming) => {
      if (!isStreaming) return intent([], 2);
      return { streamingParts: [{ content: "ready" }] };
    });
    try {
      const { code, result, stderr } = await runHeadless({
        task: "say ready",
        providerPort: provider.port,
        passCwd: false,
        prepare: (dir) => fs.writeFileSync(path.join(dir, "left-by-the-test.txt"), "x"),
      });
      expect(code, stderr.slice(-400)).toBe(0);
      expect(result.modified_files).toEqual(["?? left-by-the-test.txt"]);
    } finally {
      provider.close();
    }
  }, 60000);
});
