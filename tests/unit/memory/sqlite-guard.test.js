import { describe, it, expect } from "vitest";
import os from "node:os";
import path from "node:path";
import { assertTestSandbox, getDb } from "../../../src/memory/sqlite-store.js";

const env = { VITEST: "true" };

describe("sqlite-store test-runner guard", () => {
  it("accepts a directory inside the temp dir", () => {
    expect(() => assertTestSandbox(path.join(os.tmpdir(), "flint-x", "memory"), env)).not.toThrow();
  });

  it("refuses the real ~/.flint even when FLINT_DATA_DIR points at it", () => {
    const real = path.join(os.userInfo().homedir, ".flint", "memory");
    expect(() => assertTestSandbox(real, { ...env, FLINT_DATA_DIR: path.dirname(real) })).toThrow(/Refusing/);
  });

  it("getDb refuses FLINT_DATA_DIR set to the real home .flint", () => {
    const saved = process.env.FLINT_DATA_DIR;
    process.env.FLINT_DATA_DIR = path.join(os.userInfo().homedir, ".flint");
    try {
      expect(() => getDb()).toThrow(/Refusing/);
    } finally {
      if (saved === undefined) delete process.env.FLINT_DATA_DIR;
      else process.env.FLINT_DATA_DIR = saved;
    }
  });

  it("refuses a sibling that only shares the temp dir as a string prefix", () => {
    expect(() => assertTestSandbox(os.tmpdir() + "-evil" + path.sep + "memory", env)).toThrow(/Refusing/);
  });

  it("refuses the temp root itself and a path that climbs out of it", () => {
    expect(() => assertTestSandbox(os.tmpdir(), env)).toThrow(/Refusing/);
    expect(() => assertTestSandbox(path.join(os.tmpdir(), "..", "x"), env)).toThrow(/Refusing/);
  });

  it("does nothing outside a test runner", () => {
    expect(() => assertTestSandbox("/anywhere", {})).not.toThrow();
  });
});
