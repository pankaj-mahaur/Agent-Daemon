// SessionEnd adapter: Claude Code supplies session metadata as JSON on stdin.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { readStdinJson, passthrough } from "./io.mjs";
import { runDigest } from "../digest/digest.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export async function sessionEndDigest() {
  try {
    const input = await readStdinJson();
    const transcript = String(input.transcript_path || process.env.CLAUDE_TRANSCRIPT_PATH || "");
    if (transcript) {
      await runDigest({
        transcript,
        sessionId: String(input.session_id || process.env.CLAUDE_SESSION_ID || ""),
        cwd: String(input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd()),
        fallbackToLlm: false,
        verbose: true,
        projectRoot: PROJECT_ROOT
      });
    }
  } catch {
    // SessionEnd persistence must not cause Claude Code to report hook failure.
  }
  passthrough();
  return 0;
}
