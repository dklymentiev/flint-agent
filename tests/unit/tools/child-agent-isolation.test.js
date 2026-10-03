// A child agent gets its own data folder (queue, sessions, memory). Parent
// and child shared one tasks.db queue, so either could take the other's
// messages, and a child's start-up recover() requeued the parent's own
// long-running message (found 2026-10-02).
import { describe, it, expect, vi } from "vitest";
import path from "node:path";

vi.mock("../../../src/logging/logger.js", () => ({
  createLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
}));

const { childDataDir } = await import("../../../src/tools/agent-tools.js");

describe("childDataDir", () => {
  it("is a folder per port under the parent's data folder", () => {
    expect(childDataDir(3010, "/data/flint")).toBe(path.join("/data/flint", "children", "3010"));
    expect(childDataDir(3011, "/data/flint")).not.toBe(childDataDir(3010, "/data/flint"));
  });

  it("never is the parent's own folder", () => {
    expect(childDataDir(3010, "/data/flint")).not.toBe(path.join("/data/flint"));
  });
});
