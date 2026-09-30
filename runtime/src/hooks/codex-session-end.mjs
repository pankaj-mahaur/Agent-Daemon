#!/usr/bin/env node
// Codex SessionEnd hook — deliberately dependency-free and tiny.
//
// Codex allows SessionEnd at most 3 s, and on Windows the command already
// pays for PowerShell + node start-up. So this script only reads the hook
// payload and hands the digest to a detached `ad digest` process; loading
// the full CLI (digest pipeline, SQLite) here would risk the deadline.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../cli.mjs", import.meta.url));

export function digestArgs(input) {
  const transcript = String(input?.transcript_path ?? "");
  if (!transcript) return null;
  const args = [CLI, "digest", "--transcript", transcript, "--cwd", String(input.cwd || process.cwd())];
  if (input.session_id) args.push("--session-id", String(input.session_id));
  return args;
}

async function main() {
  let raw = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) raw += chunk;
  let input = {};
  try {
    input = JSON.parse(raw || "{}");
  } catch {
    // malformed payload → nothing to digest
  }
  const args = digestArgs(input);
  if (args) spawn(process.execPath, args, { detached: true, stdio: "ignore", windowsHide: true }).unref();
  process.stdout.write("{}");
}

const same = (a, b) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);
if (process.argv[1] && same(fileURLToPath(import.meta.url), path.resolve(process.argv[1]))) main();
