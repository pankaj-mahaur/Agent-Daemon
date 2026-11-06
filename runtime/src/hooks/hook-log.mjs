// The hook log (plan L2): one line for each thing a hook couldn't do, so
// `ad doctor` can show what went wrong where the host shows nothing (not
// every host surfaces systemMessage, and a failed hook is quiet everywhere).
//
//   adRoot()/hooks/hook.log   "<ISO time> <event> <message>"
//
// Never the prompt, the command or a file's contents: events and reasons only.
// Kept under 256 KB by dropping the older half. Best-effort: never throws.

import fs from "node:fs";
import path from "node:path";
import { adRoot } from "../ad-root.mjs";

const MAX_BYTES = 256 * 1024;

export const hookLogPath = (root = adRoot()) => path.join(root, "hooks", "hook.log");

/** Append one line. */
export function hookLog(event, message, { root = adRoot(), now = new Date() } = {}) {
  try {
    const file = hookLogPath(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const st = fs.statSync(file, { throwIfNoEntry: false });
    if (st && st.size > MAX_BYTES) {
      const text = fs.readFileSync(file, "utf8");
      const half = text.slice(Math.floor(text.length / 2));
      fs.writeFileSync(file, half.slice(half.indexOf("\n") + 1));
    }
    const clean = String(message ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
    fs.appendFileSync(file, `${now.toISOString()} ${String(event || "hook").slice(0, 40)} ${clean}\n`);
  } catch {
    // The log is a convenience: a hook never fails because of it.
  }
}

/** The last n lines (oldest first). */
export function hookLogTail(n = 5, { root = adRoot() } = {}) {
  try {
    return fs.readFileSync(hookLogPath(root), "utf8").split("\n").filter(Boolean).slice(-n);
  } catch {
    return [];
  }
}
