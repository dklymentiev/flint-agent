import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export function createTmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-test-"));
  return {
    path: dir,
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
