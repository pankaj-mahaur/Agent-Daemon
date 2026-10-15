// Notes ad shows once per install (an old env var name still in use), never on
// every run. State: ~/.agent-daemon/notes.json, {key: ISO date shown}.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const DEFAULT_NOTES_FILE = join(homedir(), ".agent-daemon", "notes.json");

/** Writes `text` to `err` the first time `key` is seen; → whether it was shown. */
export function noteOnce(key, text, { err = process.stderr, file = DEFAULT_NOTES_FILE, now = () => new Date() } = {}) {
  let seen = {};
  try {
    if (existsSync(file)) seen = JSON.parse(readFileSync(file, "utf8")) ?? {};
  } catch {
    seen = {}; // unreadable: show the note again rather than never
  }
  if (seen[key]) return false;
  err.write(`[agent-daemon] ${text}\n`);
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ ...seen, [key]: now().toISOString() }, null, 2) + "\n");
  } catch (e) {
    err.write(`[agent-daemon] could not record that the note was shown (${e.message})\n`);
  }
  return true;
}
