// Instruction files become proposals (MCP launch plan L4b): with the user's consent,
// this project's CLAUDE.md, AGENTS.md, Cursor rules, Copilot instructions and GEMINI.md
// become pending notes, one note per instruction and one review decision per file.
// ad's own blocks in those files are skipped (memory/managed-blocks.mjs).
//
//   - Only files at their usual places in the project root, never user-level files;
//     a file is read only when its real path is inside the project and it is ≤ 512 KiB.
//   - Each note is `pending` (or `quarantined` when the screen flags it), provenance
//     `instruction-file`, origin `unknown` (anyone, a cloned repo included, can write a
//     repo file). Only the review service accepts a note (02 §2.2).
//   - Re-importing the same file is a no-op. A changed file is a new import: unchanged
//     lines link to their notes, new lines become new notes, a pending note whose line is
//     gone is hidden, an accepted one is left for the user (reviewQueue lists it), and a
//     line the user rejected in review (recordRejection) is never proposed again.
//   - loaded_by: the launch hosts that already load the file by themselves, so recall
//     (L6) doesn't hand a host its own file again.

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { instructionUnits } from "./instruction-units.mjs";
import { redactSecrets } from "../security/secret-patterns.mjs";
import { screenLearning, neutralizeText } from "../digest/sanitize.mjs";
import { writeLearning, sameNote } from "./episodic.mjs";
import { normKey } from "./sqlite.mjs";
import { idOfKeys, slugOfKeys, projectClause } from "./projects.mjs";
import { hideNote } from "./review-service.mjs";
import { codexHomeDir } from "../mistakes/history.mjs";
import { ensureProposalTables, rejectedHashes, historyHashKey, textKey } from "./proposal-tables.mjs";

export const PROVENANCE = "instruction-file";
export const MAX_FILE_BYTES = 512 * 1024;
export const MAX_UNITS = 200;
// The quarantine_reason a pending note gets when the import hides it because its line left the file.
const RETIRED = "import:retired";

// Where each kind lives, in the order duplicates are resolved (the first one wins).
// loadedBy: the launch hosts that read the file by default (Claude Code: CLAUDE.md files;
// Codex: AGENTS.override.md, else AGENTS.md).
const FIXED = [
  { file: "CLAUDE.md", kind: "claude", loadedBy: ["claude-code"] },
  { file: ".claude/CLAUDE.md", kind: "claude", loadedBy: ["claude-code"] },
  { file: "CLAUDE.local.md", kind: "claude", loadedBy: ["claude-code"] },
  { file: "AGENTS.md", kind: "agents", loadedBy: ["codex"] },
  { file: "AGENTS.override.md", kind: "agents", loadedBy: ["codex"] },
  { file: "GEMINI.md", kind: "gemini", loadedBy: [] },
  { file: ".github/copilot-instructions.md", kind: "copilot", loadedBy: [] },
];
// Then .github/instructions/*.instructions.md, .cursorrules, .cursor/rules/**.

const toPosix = (p) => p.split(path.sep).join("/");

function listDir(dir, { depth = 0, max = 3, test }) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && depth < max) out.push(...listDir(p, { depth: depth + 1, max, test }));
    else if (test(e.name)) out.push(p);
  }
  return out;
}

const within = (p, root) => p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

/**
 * The instruction files of a project, without reading them.
 * @returns {{file:string, path:string, kind:string, loadedBy:string[], size:number|null, skip:string|null}[]}
 */
export function findInstructionFiles(root) {
  let realRoot;
  try {
    realRoot = fs.realpathSync.native(root);
  } catch {
    return [];
  }
  const candidates = [...FIXED.map((f) => ({ ...f, path: path.join(root, f.file) }))];
  for (const p of listDir(path.join(root, ".github", "instructions"), { max: 0, test: (n) => n.endsWith(".instructions.md") })) {
    candidates.push({ file: toPosix(path.relative(root, p)), path: p, kind: "copilot", loadedBy: [] });
  }
  candidates.push({ file: ".cursorrules", path: path.join(root, ".cursorrules"), kind: "cursor", loadedBy: [] });
  for (const p of listDir(path.join(root, ".cursor", "rules"), { max: 3, test: (n) => n.endsWith(".mdc") || n.endsWith(".md") })) {
    candidates.push({ file: toPosix(path.relative(root, p)), path: p, kind: "cursor", loadedBy: [] });
  }
  const out = [];
  const seen = new Map(); // real path → file
  for (const c of candidates) {
    let st;
    try {
      st = fs.lstatSync(c.path);
    } catch {
      continue; // not there
    }
    let real;
    try {
      real = fs.realpathSync.native(c.path);
    } catch {
      out.push({ ...c, size: null, skip: "a broken link" });
      continue;
    }
    if (!within(real, realRoot)) {
      out.push({ ...c, size: null, skip: "it links outside this project" });
      continue;
    }
    const target = st.isSymbolicLink() ? fs.statSync(real) : st;
    if (!target.isFile()) continue;
    if (seen.has(real)) {
      out.push({ ...c, size: target.size, skip: `the same file as ${seen.get(real)}` });
      continue;
    }
    seen.set(real, c.file);
    out.push({ ...c, size: target.size, skip: target.size > MAX_FILE_BYTES ? "larger than 512 KiB" : null });
  }
  return out;
}

// Which launch hosts read each file by themselves: Claude Code its CLAUDE.md files, and
// AGENTS.md when a CLAUDE.md imports it; Codex AGENTS.override.md in place of AGENTS.md,
// and CLAUDE.md when its config names it as a fallback and there is no AGENTS file
// (L4a coverage.mjs). → file → hosts
function loadedByOf(files, texts, { env, home }) {
  const out = new Map(files.map((f) => [f.file, new Set(f.loadedBy)]));
  const present = (file) => files.some((f) => f.file === file && !f.skip);
  if (files.some((f) => f.kind === "claude" && /^\s*@\.?\/?AGENTS\.md\b/m.test(texts.get(f.file) ?? ""))) out.get("AGENTS.md")?.add("claude-code");
  if (present("AGENTS.override.md")) out.get("AGENTS.md")?.delete("codex");
  let config = "";
  try {
    config = fs.readFileSync(path.join(codexHomeDir({ env, home }), "config.toml"), "utf8");
  } catch {
    config = "";
  }
  if (!present("AGENTS.md") && !present("AGENTS.override.md") && /project_doc_fallback_filenames\s*=\s*\[[^\]]*CLAUDE\.md/.test(config)) out.get("CLAUDE.md")?.add("codex");
  return out;
}

function screen(text) {
  try {
    return screenLearning({ text, evidence_quote: "", tags: [] });
  } catch {
    // a screen error counts as clean: the read-time check (render-safe.mjs) is the second layer
    return { verdict: "clean", reasons: [] };
  }
}

const sha = (s) => createHash("sha256").update(s).digest("hex");

/** A file's text: UTF-8 (a BOM dropped), or UTF-16 when its BOM says so (PowerShell 5.1's `>`). */
export function decodeText(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString("utf16le");
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const be = Buffer.from(buf.subarray(2, 2 + ((buf.length - 2) & ~1)));
    return be.swap16().toString("utf16le");
  }
  const s = buf.toString("utf8");
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/** The latest import of each instruction file of this project: file → row. */
export function latestImports(handle, keys) {
  const ik = projectClause("", keys);
  const out = new Map();
  for (const r of handle.all(`SELECT * FROM instruction_imports WHERE ${ik.sql} ORDER BY id`, ik.params)) out.set(r.file, r);
  return out;
}

/** Where a file comes in the import order (decision 14): its row owns a note two files hold. */
export function fileRank(file) {
  const i = FIXED.findIndex((f) => f.file === file);
  if (i >= 0) return i;
  if (file.startsWith(".github/instructions/")) return FIXED.length;
  if (file === ".cursorrules") return FIXED.length + 1;
  return FIXED.length + 2;
}

/**
 * Import this project's instruction files. Nothing is read unless consent is exactly true.
 * @param {{handle:any, keys:string[], root:string, consent:boolean, env?:object, home?:string, now?:Date}} opts
 * @returns {{skipped?:string, files?:object[]}}
 */
export function importInstructionFiles({ handle, keys, root, consent, env = process.env, home, now = new Date() }) {
  if (consent !== true) return { skipped: "no-consent" };
  if (!handle) return { skipped: "no-store" };
  const projectId = idOfKeys(keys);
  const slug = slugOfKeys(keys);
  if ((!projectId && !slug) || !root) return { skipped: "no-project" };
  // A folder that can't be read now (a drive not connected) would look like every file
  // deleted: import nothing instead.
  try {
    if (!fs.statSync(root).isDirectory()) return { skipped: "no-root" };
  } catch {
    return { skipped: "no-root" };
  }
  const t = now.toISOString();
  const found = findInstructionFiles(root);
  const texts = new Map();
  for (const f of found) {
    if (f.skip) continue;
    try {
      texts.set(f.file, decodeText(fs.readFileSync(f.path)));
    } catch (e) {
      f.skip = `unreadable (${e.code ?? e.message})`;
    }
  }
  const hostsOf = loadedByOf(found, texts, { env, home });
  const report = [];
  handle.transaction(() => {
    ensureProposalTables(handle);
    // Lines the user rejected in review (recordRejection); an agent's hide or a purge of
    // a hidden note never counts.
    const rejected = rejectedHashes(handle, keys);
    const hk = rejected.size ? historyHashKey() : null;
    for (const f of found) {
      if (f.skip) {
        report.push({ file: f.file, kind: f.kind, skipped: f.skip });
        continue;
      }
      const { units, scope, tooLong } = instructionUnits(texts.get(f.file));
      const kept = units.slice(0, MAX_UNITS);
      const contentHash = sha(JSON.stringify(kept.map((u) => [u.text, u.heading])));
      const prev = latestImports(handle, keys).get(f.file) ?? null;
      if (prev && prev.content_hash === contentHash) {
        report.push({ file: f.file, kind: f.kind, unchanged: true, units: prev.units });
        continue;
      }
      if (!kept.length && !prev) {
        report.push({ file: f.file, kind: f.kind, units: 0, notImported: units.length + tooLong });
        continue;
      }
      const loadedBy = [...(hostsOf.get(f.file) ?? [])].sort();
      const importId = Number(
        handle.run(
          `INSERT INTO instruction_imports (project_id, project_slug, file, kind, content_hash, units, skipped, loaded_by, scope, imported_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [projectId, slug, f.file, f.kind, contentHash, kept.length, Math.max(0, units.length - kept.length) + tooLong, JSON.stringify(loadedBy), scope ? JSON.stringify(scope) : null, t]
        ).lastInsertRowid
      );
      const r = { file: f.file, kind: f.kind, units: kept.length, proposed: 0, quarantined: 0, linked: 0, rejected: 0, notImported: Math.max(0, units.length - kept.length) + tooLong, hidden: 0, removedAccepted: 0 };
      const linked = new Set();
      for (const u of kept) {
        const unitKey = normKey(u.text);
        // What the note will hold (secrets redacted, a flagged line neutralised): the
        // lookups, the rejection check and the link all use it, so an existing note is
        // found and linked, never reinforced through writeLearning.
        const s = screen(u.text);
        const flagged = s.verdict === "suspicious";
        const clean = redactSecrets(u.text).text;
        const stored = flagged ? neutralizeText(clean) : clean;
        if (hk && (rejected.has(textKey(hk, stored)) || rejected.has(textKey(hk, u.text)))) {
          r.rejected++;
          continue;
        }
        const same = sameNote(handle, slug, stored, normKey(stored), projectId);
        let id = same?.id ?? null;
        if (id != null) {
          r.linked++;
          // A line this import hid when it left the file, back again: pending again.
          if (same.status === "hidden") handle.run("UPDATE learnings SET status = 'pending', status_at = ?, quarantine_reason = NULL WHERE id = ? AND status = 'hidden' AND quarantine_reason = ?", [t, id, RETIRED]);
        } else {
          const evidence = `${f.file}${u.heading ? ` › ${u.heading}` : ""}${scope?.globs?.length ? ` (applies to ${scope.globs.join(", ")})` : ""}`;
          id = writeLearning(handle, {
            projectSlug: slug,
            projectId,
            category: "preference",
            text: stored,
            evidence: flagged ? neutralizeText(evidence) : evidence,
            confidence: 0.6,
            origin: "unknown",
            status: flagged ? "quarantined" : "pending",
            quarantineReason: flagged ? `injection:${s.reasons.join(",")}` : null,
            appliedTo: flagged ? "quarantined" : "proposed:file",
          });
          if (id == null) {
            // The store held this text under a key sameNote doesn't look at (a 3.0 row).
            id = sameNote(handle, slug, stored, normKey(stored), projectId)?.id ?? null;
            r.linked++;
          } else {
            id = Number(id);
            handle.run("UPDATE learnings SET provenance = ? WHERE id = ? AND accepted_by IS NULL", [PROVENANCE, id]);
            if (flagged) r.quarantined++;
            else r.proposed++;
          }
        }
        if (id == null || linked.has(id)) continue;
        linked.add(id);
        handle.run("INSERT OR IGNORE INTO instruction_import_notes (import_id, learning_id, unit_key) VALUES (?, ?, ?)", [importId, id, unitKey]);
      }
      if (prev) Object.assign(r, retire(handle, { keys, file: f.file, prevId: prev.id, linked, now }));
      report.push(r);
    }
    // A file that is gone: an empty import, so its notes are retired like removed lines.
    const present = new Set(found.map((f) => f.file));
    for (const prev of latestImports(handle, keys).values()) {
      if (present.has(prev.file) || prev.units === 0) continue;
      handle.run(
        `INSERT INTO instruction_imports (project_id, project_slug, file, kind, content_hash, units, skipped, loaded_by, scope, imported_at)
         VALUES (?, ?, ?, ?, ?, 0, 0, ?, NULL, ?)`,
        [projectId, slug, prev.file, prev.kind, sha("[]"), prev.loaded_by, t]
      );
      report.push({ file: prev.file, kind: prev.kind, gone: true, units: 0, ...retire(handle, { keys, file: prev.file, prevId: prev.id, linked: new Set(), now }) });
    }
  });
  return { files: report };
}

// The file changed: its earlier version's notes that the new one doesn't hold. A pending
// one is hidden (its line is gone, unless another current file still holds it); an
// accepted one stays for the user to decide in review.
function retire(handle, { keys, file, prevId, linked, now }) {
  let hidden = 0;
  let removedAccepted = 0;
  const others = [...latestImports(handle, keys).values()].filter((i) => i.file !== file).map((i) => i.id);
  const gone = handle.all("SELECT learning_id FROM instruction_import_notes WHERE import_id = ?", [prevId]).map((r) => r.learning_id).filter((id) => !linked.has(id));
  for (const id of gone) {
    const elsewhere = others.length
      ? handle.get(`SELECT 1 AS x FROM instruction_import_notes WHERE learning_id = ? AND import_id IN (${others.map(() => "?").join(",")})`, [id, ...others])
      : null;
    if (elsewhere) continue;
    if (hideNote(handle, id, { keys, now })) {
      // Marked as the import's own hide (not the user's, not an agent's): the line may come back.
      handle.run("UPDATE learnings SET quarantine_reason = ? WHERE id = ? AND status = 'hidden'", [RETIRED, id]);
      hidden++;
    }
    else if (handle.get("SELECT 1 AS x FROM learnings WHERE id = ? AND accepted_by IS NOT NULL", [id])) removedAccepted++;
  }
  return { hidden, removedAccepted };
}
