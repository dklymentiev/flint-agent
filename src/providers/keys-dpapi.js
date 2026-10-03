// Windows DPAPI helper — protects/unprotects data using Windows Data Protection API

import { execFileSync } from "node:child_process";

export function protectData(plaintext) {
  const script = `
    Add-Type -AssemblyName System.Security
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($input)
    $encrypted = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
    [Convert]::ToBase64String($encrypted)
  `;
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const result = execFileSync("powershell", [
    "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded,
  ], {
    input: plaintext,
    encoding: "utf-8",
    timeout: 10000,
    stdio: ["pipe", "pipe", "ignore"],
  }).trim();
  return result;
}

export function unprotectData(base64) {
  const script = `
    Add-Type -AssemblyName System.Security
    $encrypted = [Convert]::FromBase64String($input)
    $bytes = [System.Security.Cryptography.ProtectedData]::Unprotect($encrypted, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
    [System.Text.Encoding]::UTF8.GetString($bytes)
  `;
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const result = execFileSync("powershell", [
    "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded,
  ], {
    input: base64,
    encoding: "utf-8",
    timeout: 10000,
    stdio: ["pipe", "pipe", "ignore"],
  }).trim();
  return result;
}
