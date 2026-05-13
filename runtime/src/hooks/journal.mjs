// Learning journal — append-only JSONL buffer at <cwd>/.agent-daemon/learning-journal.jsonl.
//
// Written by the UserPromptSubmit hook (one line per extracted learning).
// Drained by the SessionStart hook into memory + episodic SQLite, then archived.
//
// Fail-safe: every function swallows errors and returns a result object.
// Never throws — hooks must not crash the user's session.

import path from "node:path";
import fs from "node:fs/promises";

const MAX_BYTES = 5 * 1024 * 1024;       // 5 MB — rotate before unbounded growth
const JOURNAL_FILE = "learning-journal.jsonl";
const ARCHIVE_FILE = "learning-journal.archive.jsonl";

/**
 * @param {string} cwd
 * @returns {string} absolute path to the journal file
 */
export function journalPath(cwd) {
  return path.join(cwd, ".agent-daemon", JOURNAL_FILE);
}

/**
 * @param {string} cwd
 * @returns {string} absolute path to the archive file
 */
export function archivePath(cwd) {
  return path.join(cwd, ".agent-daemon", ARCHIVE_FILE);
}

/**
 * Append one or more learning entries to the journal.
 *
 * @param {{cwd: string, entries: Array<object>}} opts
 * @returns {Promise<{ok: boolean, written?: number, path?: string, error?: string}>}
 */
export async function appendLearnings({ cwd, entries }) {
  if (!cwd) return { ok: false, error: "cwd required" };
  if (!Array.isArray(entries) || entries.length === 0) {
    return { ok: true, written: 0 };
  }

  try {
    const dir = path.join(cwd, ".agent-daemon");
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, JOURNAL_FILE);

    // Rotate if too big (move current → archive, append to fresh)
    await maybeRotate({ cwd, file });

    const lines = entries
      .map(e => JSON.stringify(stamp(e)))
      .join("\n") + "\n";
    await fs.appendFile(file, lines, "utf8");
    return { ok: true, written: entries.length, path: file };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Read all journal lines (parsed JSON). Skips invalid lines silently.
 *
 * @param {{cwd: string}} opts
 * @returns {Promise<{ok: boolean, entries: Array<object>, path?: string, error?: string}>}
 */
export async function readJournal({ cwd }) {
  if (!cwd) return { ok: false, entries: [], error: "cwd required" };
  const file = journalPath(cwd);
  try {
    const raw = await fs.readFile(file, "utf8");
    const entries = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try { entries.push(JSON.parse(line)); } catch { /* skip bad line */ }
    }
    return { ok: true, entries, path: file };
  } catch (err) {
    if (err.code === "ENOENT") return { ok: true, entries: [] };
    return { ok: false, entries: [], error: err.message };
  }
}

/**
 * Move the journal into the archive (concatenating if archive exists),
 * leaving the journal empty. Called by SessionStart drain after applying.
 *
 * @param {{cwd: string}} opts
 * @returns {Promise<{ok: boolean, archivedBytes?: number, error?: string}>}
 */
export async function archiveJournal({ cwd }) {
  if (!cwd) return { ok: false, error: "cwd required" };
  const file = journalPath(cwd);
  const arch = archivePath(cwd);
  try {
    let stat;
    try { stat = await fs.stat(file); } catch { return { ok: true, archivedBytes: 0 }; }
    if (stat.size === 0) {
      await fs.unlink(file).catch(() => {});
      return { ok: true, archivedBytes: 0 };
    }
    const content = await fs.readFile(file, "utf8");
    // Trim archive if it would exceed MAX_BYTES (keep newest N bytes only)
    let existingArchive = "";
    try { existingArchive = await fs.readFile(arch, "utf8"); } catch {}
    let combined = existingArchive + content;
    if (Buffer.byteLength(combined, "utf8") > MAX_BYTES) {
      // Keep the last MAX_BYTES bytes, snapped to a newline
      const buf = Buffer.from(combined, "utf8");
      const slice = buf.subarray(buf.length - MAX_BYTES).toString("utf8");
      const firstNl = slice.indexOf("\n");
      combined = firstNl >= 0 ? slice.slice(firstNl + 1) : slice;
    }
    await fs.writeFile(arch, combined, "utf8");
    await fs.unlink(file).catch(() => {});
    return { ok: true, archivedBytes: Buffer.byteLength(content, "utf8") };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function stamp(e) {
  return {
    ts: e.ts || new Date().toISOString(),
    ...e
  };
}

async function maybeRotate({ cwd, file }) {
  try {
    const stat = await fs.stat(file);
    if (stat.size < MAX_BYTES) return;
  } catch {
    return; // file doesn't exist yet
  }
  // Move current → archive (preserves the data; the SessionStart drain will
  // also touch the archive when it processes).
  const arch = archivePath(cwd);
  try {
    const content = await fs.readFile(file, "utf8");
    let existing = "";
    try { existing = await fs.readFile(arch, "utf8"); } catch {}
    const combined = existing + content;
    await fs.writeFile(arch, combined, "utf8");
    await fs.unlink(file).catch(() => {});
  } catch { /* best-effort */ }
}
