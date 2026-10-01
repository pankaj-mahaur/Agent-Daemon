// SessionEnd adapter: the host supplies session metadata as JSON on stdin.
//
// Claude Code allows the hook 30 s, so the digest runs inline. Codex caps
// SessionEnd at 3 s, so there the digest is handed to a detached
// `ad digest` process and the hook returns at once.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hookHost, readStdinJson, passthrough } from "./io.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CLI_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "cli.mjs");

export function detachedDigestArgs({ transcript, sessionId, cwd }) {
  const args = [CLI_PATH, "digest", "--transcript", transcript, "--cwd", cwd];
  if (sessionId) args.push("--session-id", sessionId);
  return args;
}

export function spawnDetachedDigest(meta, spawnFn = spawn) {
  const child = spawnFn(process.execPath, detachedDigestArgs(meta), { detached: true, stdio: "ignore", windowsHide: true });
  child.unref?.();
  return child;
}

export async function sessionEndDigest({ spawnFn } = {}) {
  try {
    const input = await readStdinJson();
    const transcript = String(input.transcript_path || process.env.CLAUDE_TRANSCRIPT_PATH || "");
    if (transcript) {
      const meta = {
        transcript,
        sessionId: String(input.session_id || process.env.CLAUDE_SESSION_ID || ""),
        cwd: String(input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd()),
      };
      if (hookHost() === "codex") {
        spawnDetachedDigest(meta, spawnFn);
      } else {
        // Lazy: the digest pipeline (SQLite etc.) is only needed inline.
        const { runDigest } = await import("../digest/digest.mjs");
        await runDigest({ ...meta, fallbackToLlm: false, verbose: true, projectRoot: PROJECT_ROOT });
      }
    }
  } catch {
    // SessionEnd persistence must not cause the host to report hook failure.
  }
  passthrough();
  return 0;
}
