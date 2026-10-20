// The status row names the provider beside the model.

import { describe, it, expect } from "vitest";
import { statusText } from "../../../src/components/LiveZone.js";

describe("status row", () => {
  it("shows the provider before the model", () => {
    expect(statusText({ provider: "openrouter", model: "stealth/space-bunny-alpha" }))
      .toMatch(/^ openrouter · stealth\/space-bunny-alpha  \|/);
  });

  it("shows the model alone when no provider is known", () => {
    expect(statusText({ model: "m" })).toMatch(/^ m  \|/);
  });
});
