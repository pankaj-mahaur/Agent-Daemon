// PostToolUse hook for Edit/Write/MultiEdit — lints just-edited JS/TS files.
// Ported from everything-claude-code/scripts/hooks/post-edit-console-warn.js.
//
// Flags console.log lines in JS/TS files so they're not committed by accident.
// Stderr-only. Never blocks.

import { readFileSync, existsSync } from "node:fs";
import { readStdinJson, passthrough, warn } from "./io.mjs";

const JS_RE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const CONSOLE_LOG_RE = /(^|[^.\w])console\.log\s*\(/;
const MAX_LINES_REPORTED = 5;

export async function editPost() {
  const input = await readStdinJson();
  const filePath = input?.tool_input?.file_path || input?.path || input?.file || "";

  if (!filePath || !JS_RE.test(filePath) || !existsSync(filePath)) {
    passthrough();
    return;
  }

  let content;
  try {
    content = readFileSync(filePath, "utf8");
  } catch {
    passthrough();
    return;
  }

  const hits = [];
  content.split(/\r?\n/).forEach((line, i) => {
    if (CONSOLE_LOG_RE.test(line)) hits.push(`${i + 1}: ${line.trim()}`);
  });

  if (hits.length) {
    warn(`console.log left in ${filePath} (${hits.length} occurrence${hits.length > 1 ? "s" : ""}):`);
    for (const h of hits.slice(0, MAX_LINES_REPORTED)) warn(`  ${h}`);
    if (hits.length > MAX_LINES_REPORTED) warn(`  ... and ${hits.length - MAX_LINES_REPORTED} more`);
    warn("Strip these or replace with a real logger before committing.");
  }

  passthrough();
}
