// One-time memory upkeep (P5.2). Long-lived processes run it: the memory
// server at start, ad memory migrate, ad doctor, the TUI and ad run / ad chat.
// A hook never does: it must finish within its timeout.
//
//   norm-key-v1       fills norm_key on rows written before P5.2, in batches;
//                     a killed run resumes where it stopped (only empty keys are read)
//   journal-scrub-v1  rewrites every learning journal and archive written before
//                     the secret filter through redactSecrets: a temp file, then a
//                     rename; the original is kept on any error
//
// Each step leaves a memory_maintenance row when it finishes. A lock row
// (name "lock:<step>", taken over after 10 minutes) keeps two processes off the
// same step.

import fs from "node:fs";
import path from "node:path";
import { normKey } from "./sqlite.mjs";
import { redactSecrets } from "../security/secret-patterns.mjs";
import { PROJECT_FOLDER, rootProjectDirs } from "./project-dir.mjs";
import { backfillProjectIds } from "./project-db.mjs";

export const NORM_KEY_STEP = "norm-key-v1";
export const SCRUB_STEP = "journal-scrub-v1";
// P7.1a: give older rows their project id (once; new rows get theirs as they are written).
export const PROJECT_IDS_STEP = "project-ids-v1";
const LOCK_STALE_MS = 10 * 60 * 1000;
const BATCH = 2000;

const done = (handle, name) => Boolean(handle.get("SELECT 1 FROM memory_maintenance WHERE name = ?", [name]));
const finish = (handle, name, result) => handle.run("INSERT OR REPLACE INTO memory_maintenance (name, done_at, result) VALUES (?, ?, ?)", [name, new Date().toISOString(), JSON.stringify(result)]);

/** Take the step's lock; false when another process holds a fresh one. */
export function takeLock(handle, step, now = Date.now()) {
  const name = `lock:${step}`;
  return handle.transaction(() => {
    const row = handle.get("SELECT done_at FROM memory_maintenance WHERE name = ?", [name]);
    if (row && now - Date.parse(row.done_at) < LOCK_STALE_MS) return false;
    handle.run("INSERT OR REPLACE INTO memory_maintenance (name, done_at, result) VALUES (?, ?, NULL)", [name, new Date(now).toISOString()]);
    return true;
  });
}
const releaseLock = (handle, step) => handle.run("DELETE FROM memory_maintenance WHERE name = ?", [`lock:${step}`]);

/**
 * Fill norm_key for older rows. Stops after `budgetMs` (the rest next time).
 * @returns {{filled:number, finished:boolean}}
 */
export function backfillNormKeys(handle, { budgetMs = 5000, batch = BATCH, now = () => Date.now() } = {}) {
  const start = now();
  let filled = 0;
  const update = handle.raw.prepare("UPDATE learnings SET norm_key = ? WHERE id = ?");
  for (;;) {
    const rows = handle.all("SELECT id, text FROM learnings WHERE norm_key IS NULL ORDER BY id LIMIT ?", [batch]);
    if (!rows.length) return { filled, finished: true };
    handle.transaction(() => {
      for (const r of rows) update.run(normKey(r.text), r.id);
    });
    filled += rows.length;
    if (now() - start > budgetMs) return { filled, finished: false };
  }
}

const JOURNAL_RE = /^learning-journal(?:\.archive|\.draining-\d+)?\.jsonl$/;

/** Every folder that may hold a journal: each recorded project's own folder, and ad's capture folders. */
function journalDirs(handle) {
  const dirs = new Set(rootProjectDirs());
  try {
    for (const r of handle.all("SELECT DISTINCT project_path FROM sessions WHERE project_path IS NOT NULL")) dirs.add(path.join(r.project_path, PROJECT_FOLDER));
  } catch {
    // no sessions table: only ad's own folders
  }
  return [...dirs];
}

// Every string inside a parsed line, redacted: the JSON stays valid (redacting the
// raw line could cut through a quote and lose the whole entry).
const redactValue = (v) => (typeof v === "string" ? redactSecrets(v).text : Array.isArray(v) ? v.map(redactValue) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactValue(x)])) : v);

/** One journal's text with every secret redacted, line by line. */
export function scrubText(text) {
  return text
    .split("\n")
    .map((line) => {
      const body = line.replace(/\r$/, "");
      if (!body.trim()) return line;
      try {
        return JSON.stringify(redactValue(JSON.parse(body)));
      } catch {
        return redactSecrets(line).text; // not JSON: nothing to keep valid
      }
    })
    .join("\n");
}

const ORPHAN_AGE_MS = 60 * 60 * 1000;

/**
 * Scrub one file; never loses a line. The file is claimed by a rename first, so
 * a hook appending meanwhile starts a new file at the old path and a drain
 * finds nothing to take; the scrubbed lines are then appended to that path
 * (an append never replaces what a hook wrote meanwhile). A drain's own
 * .draining-<pid> file is left alone until it is an hour-old orphan.
 * → true when something was redacted.
 */
export function scrubFile(file, { now = Date.now() } = {}) {
  if (/\.draining-\d+\.jsonl$/.test(file) && now - fs.statSync(file).mtimeMs < ORPHAN_AGE_MS) return false;
  const text = fs.readFileSync(file, "utf8");
  if (scrubText(text) === text) return false;
  const claimed = `${file}.scrub-${process.pid}`;
  fs.renameSync(file, claimed);
  const mine = fs.readFileSync(claimed, "utf8");
  let out = mine;
  try {
    out = scrubText(mine);
  } catch {
    // keep the original lines rather than lose them
  }
  fs.appendFileSync(file, out && !out.endsWith("\n") ? `${out}\n` : out, "utf8");
  // A hook that opened the file before the rename may have written to the claimed copy since.
  const tail = fs.readFileSync(claimed, "utf8").slice(mine.length);
  if (tail) fs.appendFileSync(file, scrubText(tail), "utf8");
  fs.rmSync(claimed, { force: true });
  return out !== mine;
}

/** @returns {{files:number, changed:number, errors:number}} */
export function scrubJournals(handle) {
  const out = { files: 0, changed: 0, errors: 0 };
  for (const dir of journalDirs(handle)) {
    let names = [];
    try {
      const all = fs.readdirSync(dir);
      // A scrub that died between its rename and its append: put those lines back first.
      for (const n of all) {
        const m = /^(learning-journal(?:\.archive|\.draining-\d+)?\.jsonl)\.scrub-\d+$/.exec(n);
        if (!m) continue;
        const p = path.join(dir, n);
        fs.appendFileSync(path.join(dir, m[1]), scrubText(fs.readFileSync(p, "utf8")), "utf8");
        fs.rmSync(p, { force: true });
      }
      names = fs.readdirSync(dir).filter((n) => JOURNAL_RE.test(n));
    } catch {
      continue;
    }
    for (const n of names) {
      out.files++;
      try {
        if (scrubFile(path.join(dir, n))) out.changed++;
      } catch {
        out.errors++;
      }
    }
  }
  return out;
}

/**
 * Run whatever upkeep is still due. Never throws; a busy store means "next time".
 * @returns {Promise<object|null>} what ran, or null when the store is missing
 */
export async function runMemoryMaintenance({ handle, budgetMs = 5000 } = {}) {
  try {
    if (!handle) handle = await (await import("./episodic.mjs")).db();
    if (!handle) return null;
    const ran = {};
    for (const [step, work] of [
      [NORM_KEY_STEP, () => backfillNormKeys(handle, { budgetMs })],
      [SCRUB_STEP, () => ({ ...scrubJournals(handle), finished: true })],
      [PROJECT_IDS_STEP, () => ({ ...backfillProjectIds(handle), finished: true })],
    ]) {
      if (done(handle, step) || !takeLock(handle, step)) continue;
      try {
        const r = work();
        ran[step] = r;
        if (r.finished && !r.errors) finish(handle, step, r);
      } finally {
        releaseLock(handle, step);
      }
    }
    // Every run (not once): the injection ledger keeps 90 days (P5.5).
    try {
      const pruned = handle.run("DELETE FROM injections WHERE datetime(ts) < datetime('now', '-90 days')").changes;
      if (pruned) ran.injectionsPruned = pruned;
    } catch {
      // older store without the table
    }
    return ran;
  } catch {
    return null;
  }
}
