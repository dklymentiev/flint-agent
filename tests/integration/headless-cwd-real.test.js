// The system message a real --headless run produces.
//
// This runs bootstrap() and reads app.systemMessage: the object that becomes
// messages[0] and is what the model receives on its first request.
//
// The shape of the defect:
//   bootstrap() -> initSystemMessage() -> getSystemMessage() prints
//                  process.cwd(), which the launcher has set to the install
//                  directory
//   the session is seeded with [app.systemMessage]
//   buildContext(): contextMode "full" returns null, so apiMessages = messages
//                  and messages[0] is sent as it was built at startup
//   profiles/profiles.json: generic, the default profile, is contextMode "full"
//
// So the prompt built inside bootstrap() is frozen into messages[0] and sent on
// the first request, and the per-turn rebuild of app.systemMessage never
// reaches it. The chdir has to happen before that message is built, which is
// what prepareHeadless() does as the first step of bootstrap().
import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "flint-hd-"));
const dirA = repoRoot;                                    // launcher leaves us here
const dirB = path.join(tmpBase, "work", "repo");    // what --cwd names
fs.mkdirSync(dirB, { recursive: true });

const origCwd = process.cwd();
const norm = (p) => String(p).replace(/\\/g, "/").toLowerCase();

afterAll(() => {
  try { process.chdir(origCwd); } catch {}
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

function systemCwdOf(app) {
  const text = app?.systemMessage?.content ?? String(app?.systemMessage ?? "");
  return text.match(/CWD: .*/)?.[0] ?? "";
}

/** Run the real headless startup, in index.js order, from the install dir. */
async function startHeadlessRun() {
  process.chdir(dirA);
  const { app } = await import("../../src/app-state.js");
  const { bootstrap } = await import("../../src/bootstrap.js");

  // Nothing but bootstrap() is called here, on purpose. The order "enter --cwd,
  // then build the system message" is bootstrap()'s own first step
  // (prepareHeadless). An earlier version of this test called markHeadless and
  // enterCwd itself before bootstrap(), and so stayed green with the fix line
  // deleted from index.js: it proved the order it had written down, not the
  // order the product runs.
  const cli = { action: "headless", cwd: dirB, task: "say hi" };
  await bootstrap(cli, { name: "flint", version: "test" });

  return app;
}

describe("--headless: the prompt is built inside --cwd, not before it", () => {
  it("builds the system message in --cwd, launched from elsewhere", async () => {
    const app = await startHeadlessRun();
    const line = systemCwdOf(app);

    expect(
      norm(line),
      `the system message built at startup says "${line}" — the model is told this first, and it must name ${dirB}`
    ).toContain(norm(dirB));

    try { process.chdir(origCwd); } catch {}
  }, 60000);

  it("is correct in both context modes the profiles use", async () => {
    const app = await startHeadlessRun();
    const { buildContext } = await import("../../src/message-handler.js");

    const startupText = app.systemMessage?.content ?? String(app.systemMessage);
    const sessionMessages = [{ role: "system", content: startupText }];
    const userMsg = { role: "user", content: "hi" };

    // "full" — the generic profile, the default one: buildContext
    // returns null and the session's own messages[0] is sent.
    const fullCtx = buildContext(sessionMessages, userMsg);
    const fullFirst = fullCtx === null ? sessionMessages[0].content : (fullCtx[0]?.content ?? "");

    // "mini" — buildContext returns [app.systemMessage, ...]. runTurn rebuilds
    // that every turn, so this mode would have recovered from turn two on and
    // been wrong only in the first request.
    const prevMode = app.profileConfig.contextMode;
    app.profileConfig.contextMode = "mini";
    const miniFirst = buildContext(sessionMessages, userMsg)?.[0]?.content ?? "";
    app.profileConfig.contextMode = prevMode;

    for (const [label, text] of [["full", fullFirst], ["mini", miniFirst]]) {
      expect(text, `contextMode "${label}" sends no system message`).toContain("CWD:");
      expect(
        norm(text),
        `contextMode "${label}" would tell the model: ${(text.match(/CWD: .*/) || ["(none)"])[0]}`
      ).toContain(norm(dirB));
    }

    try { process.chdir(origCwd); } catch {}
  }, 60000);
});