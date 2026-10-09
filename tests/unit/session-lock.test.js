// Session lock: the half-written lock and the two-takers race.
//
// Both are about acquireSessionLock in src/sessions.js. A lock file that is
// still empty because its creator has not written the pid yet must not read
// as "stale", and two processes that both find a dead owner must not both win.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { spawn } from "node:child_process";
import { createTmpDir } from "../helpers/tmp-dir.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

let tmp;
let sessionsDir;

vi.mock("../../src/config.js", () => ({
  config: {
    get sessionsDir() {
      return globalThis.__testSessionsDir;
    },
  },
}));

const { acquireSessionLock, lockPath } = await import("../../src/sessions.js");
const sessionsUrl = pathToFileURL(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "sessions.js"),
).href;

beforeEach(() => {
  tmp = createTmpDir();
  sessionsDir = path.join(tmp.path, "sessions");
  fs.mkdirSync(sessionsDir);
  globalThis.__testSessionsDir = sessionsDir;
});

afterEach(() => {
  tmp.cleanup();
});

function sleepingChild() {
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  return child;
}

describe("acquireSessionLock: a lock that is still being written", () => {
  it("does not treat an empty lock file as stale when its owner is alive", async () => {
    const owner = sleepingChild();
    try {
      const lp = lockPath("s1");
      // The creator has opened the file ("wx") and not yet written the pid.
      fs.writeFileSync(lp, "");
      setTimeout(() => {
        try { fs.writeFileSync(lp, JSON.stringify({ pid: owner.pid, startedAt: Date.now() })); } catch {}
      }, 100);
      await expect(acquireSessionLock("s1")).rejects.toThrow(/already in use/);
    } finally {
      owner.kill();
    }
  });
});

describe("acquireSessionLock: two processes that both see a dead owner", () => {
  it("lets exactly one of them take the lock", async () => {
    const id = "s2";
    const script = `
      const { acquireSessionLock } = await import(${JSON.stringify(sessionsUrl)});
      await new Promise((r) => process.stdin.once("data", r));
      try { await acquireSessionLock(${JSON.stringify(id)}); process.stdout.write("OK\\n"); }
      catch (e) { process.stdout.write("REFUSED\\n"); }
      setTimeout(() => process.exit(0), 1500);
    `;
    for (let round = 0; round < 3; round++) {
      fs.writeFileSync(lockPath(id), JSON.stringify({ pid: 999999, startedAt: 1 }));
      const kids = [];
      for (let i = 0; i < 6; i++) {
        const c = spawn(process.execPath, ["--input-type=module", "-e", script], {
          env: { ...process.env, FLINT_DATA_DIR: tmp.path },
          stdio: ["pipe", "pipe", "ignore"],
        });
        c.out = "";
        c.stdout.on("data", (d) => { c.out += d; });
        c.done = new Promise((r) => c.on("exit", r));
        kids.push(c);
      }
      // Let every child finish importing, then release them together.
      await new Promise((r) => setTimeout(r, 2500));
      for (const c of kids) c.stdin.write("go\n");
      await Promise.all(kids.map((c) => c.done));
      const winners = kids.filter((c) => c.out.includes("OK")).length;
      expect(winners, `round ${round}: ${kids.map((c) => c.out.trim()).join(",")}`).toBe(1);
    }
  }, 60000);
});

// The takeover of a stale lock is serialised by a second file, <lock>.takeover.
// A taker that dies between creating it and removing it leaves that file
// behind for good, and without the age check every later start of the session
// waits on it and then fails: one crash at the wrong moment and the session
// cannot be opened again.
describe("acquireSessionLock: a takeover guard left by a taker that died", () => {
  it("is removed once it is old, and the stale lock is taken", async () => {
    const lp = lockPath("s3");
    fs.writeFileSync(lp, JSON.stringify({ pid: 999999, startedAt: 1 }));
    const guard = `${lp}.takeover`;
    fs.writeFileSync(guard, "");
    const longAgo = new Date(Date.now() - 60_000);
    fs.utimesSync(guard, longAgo, longAgo);

    await expect(acquireSessionLock("s3")).resolves.toBe(true);
    expect(JSON.parse(fs.readFileSync(lp, "utf-8")).pid).toBe(process.pid);
    expect(fs.existsSync(guard), "the guard was left behind again").toBe(false);
  });
});

// The exit hook removes the locks this process holds. It must not remove a
// lock file that has since become someone else's (the session was taken over
// while this process was hung, say): deleting it would let a third process in
// beside the live owner.
describe("session lock at exit", () => {
  function runAndExit(body) {
    const script = `
      import fs from "node:fs";
      const { acquireSessionLock, lockPath } = await import(${JSON.stringify(sessionsUrl)});
      await acquireSessionLock("s4");
      ${body}
      process.exit(0);
    `;
    return new Promise((resolve) => {
      const c = spawn(process.execPath, ["--input-type=module", "-e", script], {
        env: { ...process.env, FLINT_DATA_DIR: tmp.path },
        stdio: "ignore",
      });
      c.on("exit", resolve);
    });
  }
  // sessions.js run with FLINT_DATA_DIR keeps its sessions under that folder.
  const childLock = () => path.join(tmp.path, "sessions", "s4.lock");

  it("removes the lock the exiting process holds", async () => {
    await runAndExit(`if (!fs.existsSync(lockPath("s4"))) process.exit(7);`);
    expect(fs.existsSync(childLock())).toBe(false);
  }, 30000);

  it("leaves a lock that now belongs to another process", async () => {
    const other = sleepingChild();
    try {
      await runAndExit(
        `fs.writeFileSync(lockPath("s4"), JSON.stringify({ pid: ${other.pid}, startedAt: Date.now() }));`,
      );
      expect(fs.existsSync(childLock()), "the exit hook deleted another process's lock").toBe(true);
      expect(JSON.parse(fs.readFileSync(childLock(), "utf-8")).pid).toBe(other.pid);
    } finally {
      other.kill();
    }
  }, 30000);
});

// A corrupt session is moved aside so its history stays on disk. Two details
// of that were not checked by the headless test: the signature moves with the
// file, and a second corrupt file under the same id does not replace the
// first one kept (rename overwrites its target without a word).
describe("quarantineSession", () => {
  it("moves the signature along with the session file", async () => {
    const { quarantineSession } = await import("../../src/sessions.js");
    fs.writeFileSync(path.join(sessionsDir, "q1.json"), "{broken");
    fs.writeFileSync(path.join(sessionsDir, "q1.hmac"), "abc123");
    const kept = await quarantineSession("q1");
    expect(kept).toBe(path.join(sessionsDir, "q1.json.corrupt"));
    expect(fs.readFileSync(kept, "utf-8")).toBe("{broken");
    expect(fs.readFileSync(`${kept}.hmac`, "utf-8")).toBe("abc123");
    expect(fs.existsSync(path.join(sessionsDir, "q1.json"))).toBe(false);
    expect(fs.existsSync(path.join(sessionsDir, "q1.hmac")), "a stale signature was left for the next session under this id").toBe(false);
  });

  it("keeps both when the same id goes corrupt a second time", async () => {
    const { quarantineSession } = await import("../../src/sessions.js");
    fs.writeFileSync(path.join(sessionsDir, "q2.json"), "first history");
    const first = await quarantineSession("q2");
    fs.writeFileSync(path.join(sessionsDir, "q2.json"), "second history");
    const second = await quarantineSession("q2");
    expect(second).not.toBe(first);
    expect(fs.readFileSync(first, "utf-8"), "the first kept history was overwritten").toBe("first history");
    expect(fs.readFileSync(second, "utf-8")).toBe("second history");
  });
});
