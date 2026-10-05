// Prompt history for the composer (plan Part 5a), persisted as JSONL at
// ~/.agent-daemon/tui/history.jsonl: one {text, at} per line, newest last.
//
//   createHistory({file, max}) → {entries(), add(text)}
//
// The file is private (0600), appended to per prompt and compacted to the
// last `max` entries when it grows past twice that. A consecutive duplicate
// is skipped. Masked input never gets here (the composer doesn't add it).
// I/O errors never break the TUI: history just stops persisting.

import { appendFileSync, chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { sanitize } from "./terminal/sanitize.mjs";

export const DEFAULT_HISTORY_FILE = join(homedir(), ".agent-daemon", "tui", "history.jsonl");

export function createHistory({ file = DEFAULT_HISTORY_FILE, max = 1000 } = {}) {
  let list = [];
  let lines = 0; // lines in the file, compacted past 2 × max
  try {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      lines++;
      try {
        const e = JSON.parse(line);
        // The file is outside ad's control: what comes back is sanitized like typed text.
        if (typeof e?.text === "string" && e.text) list.push(sanitize(e.text, "transcript"));
      } catch {
        // A torn line from a crash: skipped.
      }
    }
  } catch {
    // No history yet.
  }
  list = list.slice(-max);

  function persist(text) {
    if (!file) return;
    try {
      mkdirSync(dirname(file), { recursive: true });
      const line = `${JSON.stringify({ text, at: new Date().toISOString() })}\n`;
      if (++lines > max * 2) {
        writeFileSync(file, list.map((t) => JSON.stringify({ text: t })).join("\n") + "\n", { mode: 0o600 });
        lines = list.length;
      } else appendFileSync(file, line, { mode: 0o600 });
      chmodSync(file, 0o600);
    } catch {
      // Read-only home or similar: history stays in memory.
    }
  }

  return {
    entries: () => list,
    add(text) {
      const t = String(text ?? "");
      if (!t.trim() || list.at(-1) === t) return;
      list.push(t);
      if (list.length > max) list = list.slice(-max);
      persist(t);
    },
  };
}
