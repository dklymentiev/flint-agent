// One door to the provider, enforced by enumeration.
//
// The rule this guards is not a style preference. Money leaves Flint through
// HTTP requests to a chat-completions endpoint; a ceiling can only hold if
// every one of those requests passes the same gate. Four modules had their own
// `fetch` at the time this was written, and the reason none of them was caught
// earlier is that nothing ever looked.
//
// So: any file under src/ that both calls `fetch` and mentions a
// chat-completions endpoint is a door, and there must be none — because the
// one real door does not mention an endpoint at all. It asks the provider
// adapter for the URL, which is what makes it the door and everyone else a
// bypass, and is checked separately below.
//
// Metadata endpoints are deliberately NOT doors. `/models`, `/credits` and
// `/auth/key` cost nothing, return no usage and cannot overspend a budget, so
// holding them to this rule would be ceremony. The test is about spending.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..", "src");

// The one file allowed to send a paid request, as a repo-relative path.
const THE_DOOR = join("src", "api", "client.js");

// What a chat-completions request looks like in this codebase, whichever
// provider it is aimed at. `config.apiUrl` is the derived one, the two paths
// are what the OpenAI-shaped and Anthropic-shaped adapters resolve to.
const COMPLETION_MARKERS = [
  "config.apiUrl",
  "chat/completions",
  "/messages",
];

function jsFilesUnder(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...jsFilesUnder(full));
    else if (name.endsWith(".js")) out.push(full);
  }
  return out;
}

function doorsInSrc() {
  const doors = [];
  for (const file of jsFilesUnder(SRC)) {
    const text = readFileSync(file, "utf8");
    if (!/\bfetch\s*\(/.test(text)) continue;
    const marker = COMPLETION_MARKERS.find((m) => text.includes(m));
    if (marker) doors.push({ file: join("src", relative(SRC, file)), marker });
  }
  return doors;
}

describe("one door to the provider", () => {
  it("nothing in src/ reaches a completions endpoint on its own", () => {
    const doors = doorsInSrc().map((d) => `${d.file.split(sep).join("/")} (${d.marker})`);
    // Named, not counted: a failure should say which file to look at, and the
    // fix is nearly always "call chatCompletion instead".
    expect(doors).toEqual([]);
  });

  it("the door is where the request actually leaves from", () => {
    // Without this, the check above would keep passing after somebody deleted
    // the sending code entirely, which is not the property we care about.
    const text = readFileSync(join(SRC, "api", "client.js"), "utf8");
    expect(text).toMatch(/adapter\.getChatUrl\(/);
    expect(text).toMatch(/await fetch\(url/);
  });

  it("the markers still describe a completions endpoint", () => {
    // The adapters resolve the URL the door sends to. If they stopped spelling
    // it this way, the scan above would be looking for nothing.
    const openai = readFileSync(join(SRC, "providers", "adapters", "openai.js"), "utf8");
    const anthropic = readFileSync(join(SRC, "providers", "adapters", "anthropic.js"), "utf8");
    expect(COMPLETION_MARKERS.some((m) => openai.includes(m))).toBe(true);
    expect(COMPLETION_MARKERS.some((m) => anthropic.includes(m))).toBe(true);
  });

  it("checks the budget before sending, not after", () => {
    const text = readFileSync(join(SRC, "api", "client.js"), "utf8");
    const gate = text.indexOf("assertWithinBudget");
    const send = text.indexOf("await fetch(");
    expect(gate).toBeGreaterThan(-1);
    expect(send).toBeGreaterThan(-1);
    // Order in the file is not order of execution in general, but here the gate
    // is a straight-line statement at the top of the same function.
    expect(gate).toBeLessThan(send);
  });
});
