// The care level of a child agent (owner, 2026-10-10).
//
// A child gets a data folder of its own, so nobody has answered "How careful
// should Flint be?" there. A child opened in a visible window drew the
// question and waited for a person, with its task already sent. The parent
// passes its own level, and may ask for a stricter one. It may not ask for a
// looser one: the level is the operator's decision about this machine, and a
// model choosing `permissive` for its child would be the model answering the
// question on the operator's behalf.
import { describe, it, expect } from "vitest";
import { childCareLevel, runCareLevel } from "../../../src/security/policies.js";

describe("childCareLevel", () => {
  it("is the parent's level when nothing is asked for", () => {
    expect(childCareLevel("permissive")).toEqual({ level: "permissive" });
    expect(childCareLevel("safe")).toEqual({ level: "safe" });
  });

  it("is the documented default when the parent was never asked", () => {
    // What the parent itself runs under in that case (getPermission).
    expect(childCareLevel(null)).toEqual({ level: "normal" });
  });

  it("may be stricter than the parent's", () => {
    expect(childCareLevel("permissive", "safe")).toEqual({ level: "safe" });
    expect(childCareLevel("normal", "normal")).toEqual({ level: "normal" });
  });

  it("is refused when looser than the parent's, not quietly lowered", () => {
    const r = childCareLevel("normal", "permissive");
    expect(r.level).toBeUndefined();
    expect(r.error).toMatch(/normal/);
    expect(r.error).toMatch(/permissive/);
  });

  it("is refused when it is not a level at all", () => {
    expect(childCareLevel("permissive", "yolo").error).toMatch(/safe, normal, permissive/);
  });
});

describe("runCareLevel", () => {
  it("reads the level a parent handed down", () => {
    expect(runCareLevel({ FLINT_CARE_LEVEL: "safe" })).toEqual({ level: "safe" });
  });

  it("is nothing when no level was handed down", () => {
    expect(runCareLevel({})).toEqual({ level: null });
    expect(runCareLevel({ FLINT_CARE_LEVEL: "" })).toEqual({ level: null });
  });

  it("refuses a value that is not a level: a typo must not start Flint at some other level", () => {
    expect(runCareLevel({ FLINT_CARE_LEVEL: "permisive" }).error).toMatch(/FLINT_CARE_LEVEL/);
  });
});
