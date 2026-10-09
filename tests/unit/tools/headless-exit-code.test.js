// Headless exit-code preservation regression.
//
// When run_command runs in headless mode it injects an EXIT trap that kills
// `&` background children. The original version ended the trap with `exit 0`,
// which discarded the real command exit code — every failing command surfaced
// to the model as a successful one.
//
// These tests mock config.headless = true so the trap is actually injected,
// then assert that the real exit code of the command reaches the model.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMockStore } from "../../helpers/mock-store.js";
import { activeChildren } from "../../../src/tools/process-tools.js";

// Mock config so headless mode is active — this is what triggers the trap.
vi.mock("../../../src/config.js", () => ({
  config: {
    shell: "bash",
    headless: true,
    baseDir: process.cwd(),
    projectRoot: process.cwd(),
    sessionsDir: require("node:path").join(process.cwd(), "sessions"),
    permissionsFile: require("node:path").join(process.cwd(), ".permissions.json"),
    allowedPaths: [],
    workdirBase: "",
    maxResponseTokens: 8192,
    maxDisplayLines: 1000,
    maxResponseLines: 500,
    maxIterations: 150,
    maxCostPerAction: 0,
    sessionBudget: 0,
    fallbackAllTools: false,
    apiAutoApprove: true,
    pluginInstall: "ask",
    selfVerify: "off",
    compressThreshold: 500,
    maxContextChars: 20000,
    maxPromptTokens: 100000,
    intentModel: null,
    extractionModel: "google/gemini-2.0-flash-001",
    apiUrl: "https://test.api/v1/chat/completions",
    provider: "test",
    model: "test-model",
    apiKey: "test-key",
    maxChildAgents: 5,
    childIdleTimeout: 0,
    childCleanupDelay: 30000,
    maxBatchFiles: 20,
    budgetWarningThresholds: [0.5, 0.8],
    securityPolicy: "normal",
    openrouterProvider: null,
    port: 3000,
    portExplicit: false,
    memoryUrl: null,
    mcpServers: null,
    compressAfterTokens: null,
  },
}));

// Mock own-env so we don't try to create venvs/npm prefixes.
vi.mock("../../../src/tools/own-env.js", () => ({
  ensureOwnEnv: () => Promise.resolve({ python: false, reason: "mocked" }),
  withOwnEnv: (env) => env,
}));

// Mock UI output functions.
vi.mock("../../../src/ui/output.js", () => ({
  printProcessStart: vi.fn(),
  printProcessEnd: vi.fn(),
  printProcessSummary: vi.fn(),
  setProcessStream: vi.fn(),
}));

// Mock last-line helper (pure string utility, no side effects needed).
vi.mock("../../../src/ui/last-line.js", () => ({
  lastOutputLine: (d) => d.toString().trim().split("\n").pop() || "",
}));

// Disable own venv so run_command doesn't try to create one.
process.env.FLINT_OWN_ENV = "0";

let store;

beforeEach(() => {
  store = createMockStore();
  activeChildren.clear();
});

afterEach(() => {
  for (const [id, child] of activeChildren) {
    try { child.kill("SIGKILL"); } catch {}
  }
  activeChildren.clear();
});

async function getHandlers() {
  const { createProcessHandlers } = await import("../../../src/tools/process-tools.js");
  return createProcessHandlers(store);
}

describe("run_command headless exit-code preservation", () => {
  it("propagates exit code 1 from `false`", async () => {
    const h = await getHandlers();
    const result = await h.run_command({ command: "false" });
    expect(result).toContain("exit 1");
    expect(result).toContain("Error");
  });

  it("propagates exit code 7 from `exit 7`", async () => {
    const h = await getHandlers();
    const result = await h.run_command({ command: "exit 7" });
    expect(result).toContain("exit 7");
    expect(result).toContain("Error");
  });

  it("propagates exit code 2 from `ls /nonexistent`", async () => {
    const h = await getHandlers();
    const result = await h.run_command({ command: "ls /nonexistent" });
    expect(result).toContain("exit 2");
    expect(result).toContain("Error");
  });

  it("returns clean exit 0 for a successful command in headless mode", async () => {
    const h = await getHandlers();
    const result = await h.run_command({ command: "echo ok" });
    expect(result.trim()).toBe("ok");
    expect(result).not.toMatch(/Error/);
  });
});
