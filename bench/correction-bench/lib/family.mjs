// Families (tasks/<split>/<id>/family.json) and their correction phrasings
// (phrasings/<split>/<id>.json). Loading validates both, so a typo fails before
// any model is paid for.
//
// family.json
//   { id, split, convention, oracle, sessions: [{ fixture, task }, …],
//     examples: { violating: {path: text}, compliant: {path: text} } }
// phrasings/<split>/<id>.json
//   { family, phrasings: [{ id, text, writer }] }   writer: an opaque label
//   ("author" for the extractor's author, "w1"… for recruited writers), never a name.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const BENCH_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ID = /^[a-z0-9][a-z0-9-]{1,40}$/;
const KINDS = new Set(["grep", "file", "command"]);

export function validateFamily(f, { dir, benchDir = BENCH_DIR } = {}) {
  const errs = [];
  if (!ID.test(f?.id ?? "")) errs.push("id: lower-case letters, digits and dashes");
  if (dir && path.basename(dir) !== f.id) errs.push(`id "${f.id}" must match its folder`);
  if (!["dev", "test"].includes(f.split)) errs.push('split: "dev" or "test"');
  if (!f.convention?.trim()) errs.push("convention: say the rule in one sentence");
  if (!KINDS.has(f.oracle?.kind)) errs.push(`oracle.kind: one of ${[...KINDS].join(", ")}`);
  if (f.oracle?.kind === "grep") {
    if (!f.oracle.files?.length || !f.oracle.forbid?.length) errs.push("grep oracle: files and forbid");
    for (const s of f.oracle.forbid ?? []) {
      try {
        new RegExp(s);
      } catch (e) {
        errs.push(`grep oracle: bad pattern ${s} (${e.message})`);
      }
    }
  }
  if (f.oracle?.kind === "file" && !f.oracle.forbidAdded?.length && !f.oracle.unchanged?.length && !(f.oracle.confine?.files?.length && f.oracle.confine?.to?.length)) errs.push("file oracle: forbidAdded, unchanged or confine {files, to}");
  if (f.oracle?.kind === "command" && (!f.oracle.script || !dir || !fs.existsSync(path.join(dir, f.oracle.script)))) errs.push("command oracle: script must exist in the family folder");
  if (!Array.isArray(f.sessions) || f.sessions.length < 2) errs.push("sessions: at least 2 (session 1 plus later ones)");
  for (const [i, s] of (f.sessions ?? []).entries()) {
    if (!s.task?.trim()) errs.push(`sessions[${i}].task`);
    if (!s.fixture || !fs.existsSync(path.join(benchDir, "repos", s.fixture))) errs.push(`sessions[${i}].fixture: no repos/${s.fixture}`);
  }
  if (!f.examples?.violating || !f.examples?.compliant) errs.push("examples: violating and compliant file sets");
  if (errs.length) throw new Error(`family ${f?.id ?? dir}: ${errs.join("; ")}`);
  return f;
}

export function validatePhrasings(p, family) {
  const errs = [];
  if (p?.family !== family.id) errs.push(`family must be "${family.id}"`);
  if (!Array.isArray(p?.phrasings) || !p.phrasings.length) errs.push("phrasings: at least one");
  const ids = new Set();
  for (const x of p?.phrasings ?? []) {
    if (!x.id || ids.has(x.id)) errs.push(`phrasing id ${x.id}: missing or repeated`);
    ids.add(x.id);
    if (!x.text?.trim()) errs.push(`phrasing ${x.id}: text`);
    if (!/^(author|w\d{1,3})$/.test(x.writer ?? "")) errs.push(`phrasing ${x.id}: writer is "author" or "w<n>", never a name`);
  }
  if (errs.length) throw new Error(`phrasings ${family.id}: ${errs.join("; ")}`);
  return p;
}

/** Every family of a split, with its phrasings: [{ family, dir, phrasings }]. */
export function loadSplit(split, { benchDir = BENCH_DIR, tasksDir, phrasingsDir } = {}) {
  const tdir = tasksDir ?? path.join(benchDir, "tasks", split);
  const pdir = phrasingsDir ?? path.join(benchDir, "phrasings", split);
  const out = [];
  for (const id of fs.readdirSync(tdir).sort()) {
    const dir = path.join(tdir, id);
    if (!fs.statSync(dir).isDirectory()) continue;
    const family = validateFamily(JSON.parse(fs.readFileSync(path.join(dir, "family.json"), "utf8")), { dir, benchDir });
    const pfile = path.join(pdir, `${id}.json`);
    const phrasings = fs.existsSync(pfile) ? validatePhrasings(JSON.parse(fs.readFileSync(pfile, "utf8")), family).phrasings : [];
    out.push({ family, dir, phrasings });
  }
  return out;
}
