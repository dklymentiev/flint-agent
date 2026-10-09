// Verifies that every synonym target in TOOL_NAME_SYNONYMS maps to a real
// registered tool, and that the synonym dispatch works end-to-end through the
// real registry (not a mock).

import { describe, it, expect, beforeEach } from "vitest";
import { initRegistry, getDefinitions, executeTool } from "../../../src/tools/registry.js";
import { createMockStore } from "../../helpers/mock-store.js";
import { TOOL_NAME_SYNONYMS, _resolveSynonymName, executeToolWithPermissions } from "../../../src/tools/permissions.js";

let store;
let registeredNames;

beforeEach(() => {
  store = createMockStore();
  initRegistry(store);
  // Must be computed AFTER initRegistry populates allTools.
  registeredNames = new Set(
    getDefinitions().map((t) => t.function?.name).filter(Boolean)
  );
});

describe("synonym table integrity", () => {
  it("every synonym target is a real registered tool", () => {
    const missing = Object.entries(TOOL_NAME_SYNONYMS)
      .filter(([, target]) => !registeredNames.has(target))
      .map(([syn, target]) => `${syn}→${target}`);
    expect(missing, `these synonym targets are not registered: ${missing.join(", ")}`).toEqual([]);
  });

  it("no synonym target is itself a registered tool name", () => {
    // A synonym pointing at a name that also has its own entry would be
    // circular/confusing. Each target must be the canonical name.
    for (const [syn, target] of Object.entries(TOOL_NAME_SYNONYMS)) {
      if (registeredNames.has(syn)) {
        // If the synonym name itself is a real tool, the table entry is dead
        // — _resolveSynonymName is only consulted for unregistered names.
        // This is an error condition: the table should not list real tools.
        expect.fail(`synonym '${syn}' is itself a registered tool — remove it from the table`);
      }
    }
  });
});

describe("synonym dispatch through real registry", () => {
  it("shell dispatches to run_command handler", async () => {
    // run_command reads its command from args.command. We point it at a
    // no-op to avoid running a real process in this test.
    // Instead, verify dispatch: the synonym resolves, then executeToolWithPermissions
    // calls the real executeTool with the resolved name.
    const { result, synonym, denied } = await executeToolWithPermissions("shell", { command: "true" });
    // In test context, run_command may be denied at "safe" level or execute.
    // The key assertion: it was NOT treated as an unknown tool.
    expect(synonym).toBe("shell");
    // If denied, the denial is for run_command's permission, not "unknown tool".
    if (denied) {
      expect(result).not.toContain("unknown tool");
    }
  });

  it("read dispatches to read_file handler", async () => {
    // read_file needs a real file. Use a temp file.
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const tmp = path.join(os.tmpdir(), `synonym-test-${Date.now()}.txt`);
    fs.writeFileSync(tmp, "hello from synonym test");
    try {
      const { result, synonym, denied } = await executeToolWithPermissions("read", { path: tmp });
      expect(synonym).toBe("read");
      expect(denied).toBe(false);
      expect(result).toContain("hello from synonym test");
    } finally {
      fs.unlinkSync(tmp);
    }
  });
});
