// An npm install never keeps state inside its own package folder: npm replaces
// that folder on every update, and what Flint had written there went with it
// (sessions, saved permissions, file memory). What happens to a real install
// is checked by scripts/install-smoke.sh; this is the rule that decides.

import { describe, it, expect } from "vitest";
import { isPackageInstall } from "../../src/data-dir.js";

describe("isPackageInstall", () => {
  it.each([
    "/usr/local/lib/node_modules/flint-agent",
    "/home/someone/.npm-global/lib/node_modules/flint-agent",
    "C:\\Users\\someone\\AppData\\Roaming\\npm\\node_modules\\flint-agent",
    "/srv/app/node_modules/flint-agent",
  ])("%s is an npm install", (root) => {
    expect(isPackageInstall(root)).toBe(true);
  });

  it.each([
    "/home/someone/src/flint-agent",
    "C:\\projects\\flint-agent",
    "/opt/flint/app",
    "/home/someone/node_modules_backup/flint-agent",
  ])("%s is not", (root) => {
    expect(isPackageInstall(root)).toBe(false);
  });
});
