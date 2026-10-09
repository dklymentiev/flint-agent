import chalk from "chalk";
import path from "node:path";
import { listSessions } from "./sessions.js";
import { migrateEnvKey, setKey, hasKey } from "./providers/keys.js";
import { listProviders, getProvider } from "./providers/registry.js";
import { setActiveProvider, setLastModel } from "./providers/state.js";
import { config, needsFirstRunSetup } from "./config.js";
import { confirmWizardModel } from "./model-availability.js";

// -- CLI argument parsing --

export function getArgValue(name) {
  const idx = process.argv.indexOf(name);
  return (idx !== -1 && process.argv[idx + 1]) ? process.argv[idx + 1] : null;
}

export function parseCLI() {
  const args = process.argv;
  // --data-dir is applied by data-dir-flag.js, the first import of index.js.
  if (args.includes("--list")) return { action: "list" };
  if (args.includes("--headless")) {
    const taskIdx = args.indexOf("--task");
    const task = (taskIdx !== -1 && args[taskIdx + 1]) ? args[taskIdx + 1] : null;
    const cwdIdx = args.indexOf("--cwd");
    const cwd = (cwdIdx !== -1 && args[cwdIdx + 1]) ? path.resolve(args[cwdIdx + 1]) : null;
    const budgetIdx = args.indexOf("--budget");
    const budget = (budgetIdx !== -1 && args[budgetIdx + 1]) ? parseFloat(args[budgetIdx + 1]) : null;
    const timeLimitIdx = args.indexOf("--time-limit");
    const timeLimit = (timeLimitIdx !== -1 && args[timeLimitIdx + 1]) ? parseFloat(args[timeLimitIdx + 1]) : null;
    const sessionIdx = args.indexOf("--session");
    const session = (sessionIdx !== -1 && args[sessionIdx + 1]) ? args[sessionIdx + 1] : null;
    const systemPromptIdx = args.indexOf("--system-prompt");
    const systemPrompt = (systemPromptIdx !== -1 && args[systemPromptIdx + 1]) ? args[systemPromptIdx + 1] : null;
    const systemPromptFileIdx = args.indexOf("--system-prompt-file");
    const systemPromptFile = (systemPromptFileIdx !== -1 && args[systemPromptFileIdx + 1]) ? args[systemPromptFileIdx + 1] : null;
    const appendSystemPromptIdx = args.indexOf("--append-system-prompt");
    const appendSystemPrompt = (appendSystemPromptIdx !== -1 && args[appendSystemPromptIdx + 1]) ? args[appendSystemPromptIdx + 1] : null;
    const appendSystemPromptFileIdx = args.indexOf("--append-system-prompt-file");
    const appendSystemPromptFile = (appendSystemPromptFileIdx !== -1 && args[appendSystemPromptFileIdx + 1]) ? args[appendSystemPromptFileIdx + 1] : null;
    return { action: "headless", task, cwd, budget, timeLimit, id: session, systemPrompt, systemPromptFile, appendSystemPrompt, appendSystemPromptFile };
  }
  // Minimal runtime probe: verifies key, model, and tool round-trip without
  // running a full task. Exits with 0 (ok), 10 (no key), 11 (model did not
  // answer), 12 (tool did not round-trip).
  if (args.includes("--check")) return { action: "check" };
  if (args.includes("--new")) return { action: "new" };
  if (args.includes("--last")) return { action: "last" };
  const idx = args.indexOf("--session");
  if (idx !== -1 && args[idx + 1])
    return { action: "resume", id: args[idx + 1] };
  return { action: "new" };
}

export async function runListSessions() {
  const sessions = await listSessions();
  if (!sessions.length) {
    console.log(chalk.gray("No sessions found."));
  } else {
    console.log(chalk.cyan.bold("\n  Sessions:\n"));
    for (const s of sessions) {
      console.log(`  ${chalk.yellow(s.id)}  ${chalk.gray(s.model)}  ${s.preview}`);
    }
    console.log();
  }
  process.exit(0);
}

export async function migrateKeys() {
  // In headless mode the key comes from the environment and must not be
  // persisted to disk. The caller did not ask for a key file to be created.
  if (config.headless) return;
  await migrateEnvKey("OPENROUTER_API_KEY", "openrouter");
  await migrateEnvKey("OPENAI_API_KEY", "openai");
  await migrateEnvKey("ANTHROPIC_API_KEY", "anthropic");
}

/** Real provider keys are long tokens; a few characters is a stray keypress. */
export function looksLikeApiKey(key) {
  const k = String(key || "").trim();
  return k.length >= 20 && !/\s/.test(k);
}

export async function runFirstRunSetup(cli) {
  if (!needsFirstRunSetup || cli.action === "list") return;

  const readline = await import("node:readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((r) => rl.question(q, r));

  console.log(chalk.cyan("\n  +-------------------------------------+"));
  console.log(chalk.cyan("  |     Flint Agent -- First Run       |"));
  console.log(chalk.cyan("  +-------------------------------------+\n"));
  console.log(chalk.gray("  No API keys found. Let's set one up.\n"));

  const providers = listProviders().filter((p) => p.keyRequired);
  for (let i = 0; i < providers.length; i++) {
    console.log(chalk.white(`  ${i + 1}. ${providers[i].name} (${providers[i].id})`));
  }
  console.log(chalk.white(`  ${providers.length + 1}. Ollama (local, no key needed)`));
  console.log();

  const choice = await ask(chalk.cyan("  Choose provider (number): "));
  const idx = parseInt(choice.trim(), 10) - 1;

  if (idx === providers.length) {
    config.provider = "ollama";
    setActiveProvider("ollama");
    config.model = "llama3.2";
    console.log(chalk.green("\n  Selected Ollama (localhost:11434).\n"));
    // Ollama answers 404 for a model that is not pulled; check before the
    // first message does.
    config.model = await confirmWizardModel("ollama", config.model, { ask });
    setLastModel("ollama", config.model);
  } else if (idx >= 0 && idx < providers.length) {
    const selected = providers[idx];
    // Owner, 2026-10-01: the spinner hid this prompt, a stray "1" was saved as
    // the OpenRouter key, and the wizard said "Key saved". Anything this short
    // is not a key, so ask again rather than store it.
    let trimmedKey = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      trimmedKey = (await ask(chalk.cyan(`  Enter ${selected.name} API key: `))).trim();
      if (!trimmedKey || looksLikeApiKey(trimmedKey)) break;
      console.log(chalk.yellow("  That does not look like an API key (too short). Paste the full key."));
      trimmedKey = "";
    }
    if (trimmedKey) {
      await setKey(selected.id, trimmedKey);
      config.provider = selected.id;
      config.apiKey = trimmedKey;
      setActiveProvider(selected.id);
      // The default may have been retired since this release; ask the
      // provider with the new key and offer a live model if so.
      config.model = await confirmWizardModel(selected.id, selected.defaultModel, { ask });
      if (config.model !== selected.defaultModel) setLastModel(selected.id, config.model);
      console.log(chalk.green(`\n  Key saved (encrypted). Provider: ${selected.name}, Model: ${config.model}\n`));
    } else {
      console.log(chalk.yellow("\n  No key entered. You can add one later with /key <provider>.\n"));
    }
  } else {
    console.log(chalk.yellow("\n  Invalid choice. You can set up later with /key <provider>.\n"));
  }

  // Once, at the end of the first run: where Flint lives (owner, 2026-10-02:
  // one line, no nagging).
  console.log(chalk.gray("  Flint is free and open source: https://klymentiev.com/projects/flint\n"));
  rl.close();
}
