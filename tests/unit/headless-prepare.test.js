// Two things the first version of the headless startup fix got wrong.
//
// The first version of the fix called enterCwd({ cwd: cli.cwd }) for every
// action. The stdio mode also carries a cwd on its cli object, so a stdio run
// had config.projectRoot repointed at the agent's folder, and everything that
// resolves from projectRoot at call time followed it there: the bus plugins
// directory (code that gets imported) and the directory the log collector
// cleans. Only a headless run may be moved.
//
// And one more way to wait for a human that the first version left open: with
// no API key configured the key wizard reads stdin, in a headless run too.
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "flint-prep-"));
const origCwd = process.cwd();

async function load() {
  const { config } = await import("../../src/config.js");
  const mod = await import("../../src/headless-start.js");
  const saved = { projectRoot: config.projectRoot, workdir: config.workdir, headless: config.headless };
  const restore = () => {
    Object.assign(config, saved);
    try { process.chdir(origCwd); } catch {}
  };
  return { config, restore, ...mod };
}

let restore;
afterEach(() => { restore?.(); restore = undefined; });

describe("prepareHeadless moves a headless run and nothing else", () => {
  it("enters --cwd and marks the run for a headless cli", async () => {
    const m = await load(); restore = m.restore;

    const entered = m.prepareHeadless({ action: "headless", cwd: tmpBase });

    expect(entered).toBe(tmpBase);
    expect(m.config.headless).toBe(true);
    expect(fs.realpathSync(process.cwd())).toBe(fs.realpathSync(tmpBase));
    expect(m.config.projectRoot).toBe(tmpBase);
  });

  for (const action of ["stdio", "new", "last", "list", undefined]) {
    it(`leaves the process and the config alone for action ${action}`, async () => {
      const m = await load(); restore = m.restore;
      const before = { cwd: process.cwd(), projectRoot: m.config.projectRoot, workdir: m.config.workdir, headless: m.config.headless };

      const entered = m.prepareHeadless({ action, cwd: tmpBase });

      expect(entered).toBeNull();
      expect(process.cwd(), "the working directory moved").toBe(before.cwd);
      expect(m.config.projectRoot, "projectRoot was repointed").toBe(before.projectRoot);
      expect(m.config.workdir, "workdir was repointed").toBe(before.workdir);
      expect(m.config.headless, "the run was marked headless").toBe(before.headless);
    });
  }

  it("can be called twice with the same result", async () => {
    const m = await load(); restore = m.restore;
    const cli = { action: "headless", cwd: tmpBase };

    m.prepareHeadless(cli);
    const again = m.prepareHeadless(cli);

    expect(again).toBe(tmpBase);
    expect(fs.realpathSync(process.cwd())).toBe(fs.realpathSync(tmpBase));
  });
});

describe("a headless run with no key refuses instead of opening the wizard", () => {
  it("names what is missing", async () => {
    const m = await load(); restore = m.restore;
    const text = m.headlessSetupRefusal({ action: "headless" }, true);
    expect(text).toMatch(/No API key/);
    expect(text).toMatch(/environment/);
  });

  it("says nothing when a key is configured", async () => {
    const m = await load(); restore = m.restore;
    expect(m.headlessSetupRefusal({ action: "headless" }, false)).toBeNull();
  });

  it("leaves the wizard to an interactive start", async () => {
    const m = await load(); restore = m.restore;
    for (const action of ["new", "last", undefined]) {
      expect(m.headlessSetupRefusal({ action }, true)).toBeNull();
    }
  });
});
