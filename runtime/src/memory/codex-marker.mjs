// The Codex marker check (MCP launch plan L3, Decision 22), run by session.start
// --host codex. Dependency-free (the hook path): the ledger names the config.toml
// setup wrote AD_TOOL_SHELL into; a plain-text look at that file says whether the
// line is still there (Codex or the user may rewrite the file).

import fs from "node:fs";
import { readItems } from "./ledger-read.mjs";

// AD_TOOL_SHELL = "1": a line under [shell_environment_policy.set], a dotted or quoted
// key, or inside an inline table (set = { AD_TOOL_SHELL = "1" }). Plain text, so a line
// elsewhere in the file also counts (the safe side: no message).
const KEY = /(?:^|[\s{,.])["']?AD_TOOL_SHELL["']?[ \t]*=/m;
const MARKER = /(?:^|[\s{,.])["']?AD_TOOL_SHELL["']?[ \t]*=[ \t]*(["'])1\1/m;

/**
 * → { file, version } when setup put the marker in a config.toml that no longer holds
 * it, else null (never set up, the user had it before, or the file can't be read now).
 */
export function codexMarkerMissing(root) {
  const item = readItems(root).find((i) => i.host === "codex" && i.kind === "env" && !i.source && !i.preExisted);
  if (!item?.file) return null;
  let text;
  try {
    text = fs.readFileSync(item.file, "utf8");
  } catch (e) {
    // The whole file gone counts as missing; a passing read error doesn't.
    return e?.code === "ENOENT" ? { file: item.file, version: item.version ?? null } : null;
  }
  // There with another value: the user's choice, which setup leaves alone; no message to repeat.
  if (MARKER.test(text) || KEY.test(text)) return null;
  return { file: item.file, version: item.version ?? null };
}
