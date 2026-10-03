import chalk from "chalk";
import { listSessions } from "./sessions.js";
import { migrateEnvKey, setKey, hasKey } from "./providers/keys.js";
import { listProviders, getProvider } from "./providers/registry.js";
import { setActiveProvider, setLastModel } from "./providers/state.js";
import { config, needsFirstRunSetup } from "./config.js";

// -- CLI argument parsing --

export function getArgValue(name) {
  const idx = process.argv.indexOf(name);
  return (idx !== -1 && process.argv[idx + 1]) ? process.argv[idx + 1] : null;
}

export function parseCLI() {
  const args = process.argv;
  if (args.includes("--list")) return { action: "list" };
  if (args.includes("--headless")) {
    const taskIdx = args.indexOf("--task");
    const task = (taskIdx !== -1 && args[taskIdx + 1]) ? args[taskIdx + 1] : null;
    const cwdIdx = args.indexOf("--cwd");
    const cwd = (cwdIdx !== -1 && args[cwdIdx + 1]) ? args[cwdIdx + 1] : null;
    const budgetIdx = args.indexOf("--budget");
    const budget = (budgetIdx !== -1 && args[budgetIdx + 1]) ? parseFloat(args[budgetIdx + 1]) : null;
    return { action: "headless", task, cwd, budget };
  }
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
    console.log(chalk.green("\n  Selected Ollama. Make sure it's running on localhost:11434.\n"));
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
      config.model = selected.defaultModel;
      console.log(chalk.green(`\n  Key saved (encrypted). Provider: ${selected.name}, Model: ${selected.defaultModel}\n`));
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
