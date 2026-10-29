// A bundle's manifest (P7.1b): manifest.json, the first entry of every .adstate. It says what is
// inside, from where, and what was left out on purpose.
//
//   buildManifest(o) → the manifest object (formatVersion 1)
//   validateManifest(m) → [] when fine, else the problems (each a short sentence)
//   newExportId(now) → "exp_<ULID>"
//
// Validation refuses an unknown formatVersion, an unknown top-level key with content, a file
// outside global/ and projects/<id>/ (or a name the bundle can't hold), a file listed twice, a
// file in an undeclared project, and a byProject count for a project the bundle doesn't carry
// ("global" only when the scope includes global memory).

import { randomBytes } from "node:crypto";
import { validateEntryName } from "./names.mjs";

export const FORMAT_VERSION = 1;
const KEYS = new Set(["formatVersion", "exportId", "createdAt", "source", "scope", "projects", "classes", "files", "db", "secretPolicy", "resume", "accounts", "recallProbes", "warnings"]);
const RESUME = new Set(["none", "view-only", "linked", "native"]);

const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export function newExportId(now = Date.now()) {
  let t = "";
  let n = now;
  for (let i = 0; i < 10; i++) {
    t = B32[n % 32] + t;
    n = Math.floor(n / 32);
  }
  const r = randomBytes(16);
  let s = "";
  for (let i = 0; i < 16; i++) s += B32[r[i] % 32];
  return `exp_${t}${s}`;
}

export function buildManifest({ exportId = newExportId(), createdAt = new Date().toISOString(), source = {}, scope = { projects: "selected", globalMemory: false }, projects = [], classes = [], files = [], db = [], accounts = [], recallProbes = [], warnings = [], resume = { engineThreads: "none" } } = {}) {
  return {
    formatVersion: FORMAT_VERSION,
    exportId,
    createdAt,
    source,
    scope,
    projects,
    classes,
    files,
    db,
    secretPolicy: "none",
    resume,
    accounts,
    recallProbes,
    warnings,
  };
}

const empty = (v) => v === undefined || v === null || (Array.isArray(v) && !v.length) || (typeof v === "object" && !Array.isArray(v) && !Object.keys(v).length);

export function validateManifest(m) {
  const out = [];
  if (!m || typeof m !== "object" || Array.isArray(m)) return ["the manifest isn't an object"];
  if (m.formatVersion !== FORMAT_VERSION) return [`formatVersion ${JSON.stringify(m.formatVersion)} isn't one this ad reads (it reads ${FORMAT_VERSION})`];
  for (const k of Object.keys(m)) if (!KEYS.has(k) && !empty(m[k])) out.push(`an unknown field with content: ${k}`);
  if (typeof m.exportId !== "string" || !/^exp_[0-9A-HJKMNP-TV-Z]{26}$/.test(m.exportId)) out.push("exportId isn't an export id");
  if (m.secretPolicy !== "none") out.push("secretPolicy must be none: a bundle never carries secrets");
  if (!RESUME.has(m.resume?.engineThreads)) out.push("resume.engineThreads isn't one of none, view-only, linked, native");
  const projects = new Set();
  for (const p of Array.isArray(m.projects) ? m.projects : []) {
    if (typeof p?.id !== "string") out.push("a project without an id");
    else if (projects.has(p.id)) out.push(`project ${p.id} is listed twice`);
    else projects.add(p.id);
  }
  const seen = new Set();
  for (const f of Array.isArray(m.files) ? m.files : []) {
    const why = validateEntryName(f?.path ?? "");
    if (why || f.path === "manifest.json") out.push(`${JSON.stringify(f?.path)}: ${why ?? "the manifest itself"}`);
    else if (seen.has(f.path)) out.push(`${JSON.stringify(f.path)} is listed twice`);
    else {
      seen.add(f.path);
      const seg = f.path.split("/");
      if (seg[0] === "projects" && !projects.has(seg[1])) out.push(`${JSON.stringify(f.path)} belongs to a project the bundle doesn't declare`);
    }
    if (!Number.isInteger(f?.size) || f.size < 0) out.push(`${JSON.stringify(f?.path)}: size isn't a whole number`);
    if (typeof f?.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(f.sha256)) out.push(`${JSON.stringify(f?.path)}: sha256 isn't a hash`);
  }
  for (const d of Array.isArray(m.db) ? m.db : []) {
    for (const [table, t] of Object.entries(d?.tables ?? {})) {
      for (const key of Object.keys(t?.byProject ?? {})) {
        if (key === "global" ? !m.scope?.globalMemory : !projects.has(key)) out.push(`db ${table}: a count for ${key}, which the bundle doesn't carry`);
      }
    }
  }
  return out;
}
