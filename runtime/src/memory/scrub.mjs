// A forgotten note's words leave the capture files too (MCP launch plan L8, design decision
// 16; L5's interfaces list). review-service.mjs forgetAccepted runs it after every forget
// for good (the CLI's, `learnings forget`, and `ad review`'s), with the words of the note and
// of the rows it replaced:
//   - journals (learning-journal.jsonl, .archive, an orphaned .draining-<pid>) in every
//     capture folder (maintenance.mjs journalDirs) lose the lines that carry the words, through
//     maintenance.mjs scrubFile (claimed by a rename: a hook appending meanwhile or a drain
//     loses nothing; a drain's own file still in use is reported);
//   - proposal files (.md, .json in proposed/, proposed/_global/, applied/) keep every other
//     line: a line (in JSON, a string value) that carries the words becomes "[forgotten]".
//     Nothing else is deleted.
// A line carries the words when its text (or evidence) has the same normalised words, or,
// for words of 20 characters or more, contains them. Best effort: what can't be changed is
// reported, never fails the forget. A file git tracks is reported, not changed (D2).

import fs from "node:fs";
import path from "node:path";
import { normKey } from "./sqlite.mjs";
import { JOURNAL_RE, journalDirs, scrubFile } from "./maintenance.mjs";
import { PROJECT_FOLDER, globalProposedDir, outsideDir } from "./project-dir.mjs";

export const MIN_CONTAINS = 20;
export const FORGOTTEN_LINE = "[forgotten]";
const squash = (s) => String(s ?? "").normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

function matcher(texts) {
  const keys = new Set(texts.map((t) => normKey(t)));
  const long = texts.map(squash).filter((w) => w.length >= MIN_CONTAINS);
  return (value) => {
    if (typeof value !== "string" || !value.trim()) return false;
    if (keys.has(normKey(value))) return true;
    const v = squash(value);
    return long.some((w) => v.includes(w));
  };
}

/**
 * A journal's text without the lines whose note is the forgotten one. A line whose
 * evidence (the prompt it came from) only quotes the words keeps its own note, with the
 * evidence replaced: one prompt can carry several notes still waiting to be stored.
 */
export function dropForgotten(text, texts) {
  const carries = matcher(texts);
  const out = [];
  for (const line of text.split("\n")) {
    const body = line.replace(/\r$/, "");
    if (!body.trim()) {
      out.push(line);
      continue;
    }
    let j;
    try {
      j = JSON.parse(body);
    } catch {
      if (!carries(body)) out.push(line);
      continue;
    }
    if (carries(j?.text)) continue;
    // The journal's quote field is evidence_quote (hooks/extractors.mjs); evidence on older lines.
    const quoted = j && typeof j === "object" ? ["evidence_quote", "evidence"].filter((k) => carries(j[k])) : [];
    out.push(quoted.length ? JSON.stringify({ ...j, ...Object.fromEntries(quoted.map((k) => [k, FORGOTTEN_LINE])) }) + (line.endsWith("\r") ? "\r" : "") : line);
  }
  return out.join("\n");
}

/** A JSON proposal with each string value that carries the words replaced by "[forgotten]" (still valid JSON). */
export function blankForgottenJson(text, texts) {
  const carries = matcher(texts);
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    return blankForgotten(text, texts);
  }
  const walk = (v) => (typeof v === "string" ? (carries(v) ? FORGOTTEN_LINE : v) : Array.isArray(v) ? v.map(walk) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)])) : v);
  const next = walk(j);
  if (JSON.stringify(next) === JSON.stringify(j)) return text;
  // Keep the file's own layout: compact stays compact, indented stays indented.
  const indent = /^\s*[[{]\s*\r?\n(\s+)/.exec(text)?.[1] ?? "";
  return `${JSON.stringify(next, null, indent || undefined)}${text.endsWith("\n") ? "\n" : ""}`;
}

/** A proposal's text with each line that carries the words replaced by "[forgotten]". */
export function blankForgotten(text, texts) {
  const carries = matcher(texts);
  return text
    .split("\n")
    .map((line) => {
      const body = line.replace(/\r$/, "");
      const bare = body.replace(/^\s*(?:[-*>]\s+|\d+\.\s+)?(?:\*\*)?(?:text|lesson|learning)?:?\s*(?:\*\*)?\s*/i, "").replace(/^["'`]|["'`,]$/g, "");
      return body.trim() && (carries(bare) || carries(body)) ? FORGOTTEN_LINE + (line.endsWith("\r") ? "\r" : "") : line;
    })
    .join("\n");
}

/** This project's capture folders: each folder it was used in, and ad's folder for it. */
export function projectDirs(handle, { slug = null, id = null, paths: known = [] }) {
  const dirs = new Set();
  let paths = [];
  try {
    paths = handle.all("SELECT DISTINCT project_path AS p FROM sessions WHERE project_path IS NOT NULL AND (project_slug IS ? OR (? IS NOT NULL AND project_id = ?))", [slug, id, id]).map((r) => r.p);
  } catch {
    try {
      paths = handle.all("SELECT DISTINCT project_path AS p FROM sessions WHERE project_path IS NOT NULL AND project_slug IS ?", [slug]).map((r) => r.p);
    } catch {
      paths = [];
    }
  }
  // Also the folders the note itself was recorded in (a project with no sessions row: remember in a terminal).
  for (const p of [...new Set([...paths, ...known.filter(Boolean)])]) {
    dirs.add(path.join(p, PROJECT_FOLDER));
    try {
      dirs.add(outsideDir(p, { create: false }));
    } catch {
      // the registry is busy: the folder inside the project still counts
    }
  }
  return [...dirs];
}

function list(dir) {
  try {
    return fs.readdirSync(dir).map((n) => path.join(dir, n));
  } catch {
    return [];
  }
}

// A capture folder inside a repository (<repo>/.agent-daemon) may hold tracked files.
function trackedIn(dir, tracked) {
  if (path.basename(dir) !== PROJECT_FOLDER) return () => false;
  const repo = path.dirname(dir);
  return (file) => tracked(file, repo);
}

/**
 * @param {any} handle the store (its sessions name the projects' folders)
 * @param {string[]} texts the forgotten words (the note's and the ones it replaced)
 * @param {{now?: number, tracked?: (file:string, repo:string)=>boolean, dirs?: string[], globalDir?: string}} [o]
 * @returns {{changed: string[], left: string[]}}
 */
export function scrubForgotten(handle, texts, { now = Date.now(), tracked = () => false, dirs, globalDir, project } = {}) {
  const res = { changed: [], left: [] };
  const words = (texts ?? []).filter((t) => typeof t === "string" && t.trim());
  if (!words.length) return res;
  // A project's note: only that project's folders (other projects' captures are theirs).
  // A global note: every capture folder.
  const folders = dirs ?? (project ? projectDirs(handle, project) : journalDirs(handle));
  const journal = (text) => dropForgotten(text, words);
  const proposal = (text) => blankForgotten(text, words);
  const files = [];
  for (const dir of folders) {
    const isTracked = trackedIn(dir, tracked);
    for (const f of list(dir)) if (JOURNAL_RE.test(path.basename(f))) files.push({ f, kind: "journal", isTracked });
    for (const sub of ["proposed", "applied"]) for (const f of list(path.join(dir, sub))) files.push({ f, kind: "proposal", isTracked });
  }
  if (!project || globalDir) for (const f of list(globalDir ?? globalProposedDir())) files.push({ f, kind: "proposal", isTracked: () => false });
  for (const { f, kind, isTracked } of files) {
    try {
      if (kind === "proposal" && !/\.(md|json)$/i.test(f)) continue;
      if (!fs.statSync(f).isFile()) continue;
      const text = fs.readFileSync(f, "utf8");
      const next = kind === "journal" ? journal(text) : /\.json$/i.test(f) ? blankForgottenJson(text, words) : proposal(text);
      if (next === text) continue;
      if (isTracked(f)) {
        res.left.push(f);
        continue;
      }
      if (kind === "journal") {
        if (scrubFile(f, { now, transform: journal })) res.changed.push(f);
        else res.left.push(f); // a drain's own file, still in use
      } else {
        const tmp = `${f}.forget-${process.pid}`;
        fs.writeFileSync(tmp, next);
        fs.renameSync(tmp, f);
        res.changed.push(f);
      }
    } catch {
      res.left.push(f);
    }
  }
  return res;
}
