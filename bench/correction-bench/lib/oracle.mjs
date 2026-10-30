// Deterministic oracles: did the agent's change follow the family's convention?
// No model judges the primary outcome.
//
// Each oracle reads the session's changes (lib/fixture.mjs) and returns
//   { opportunity, violated, detail }
// opportunity: the change touched what the convention governs (a session that
// never wrote a log line had no chance to break the logging rule). Only
// opportunities count in the repeat-mistake rate.
//
// Kinds:
//   grep     { files, except?, forbid }  a forbidden pattern in an ADDED line of a
//            changed file matching `files` (and not `except`)
//   file     { opportunity?, forbidAdded?, unchanged?, confine?: {files, to} }  where
//            files may appear, and which may not change; no `opportunity` means
//            every session is one
// grep ignores comments: restating the rule in a comment is not breaking it.
// Known limit: renaming a helper (src/lib/api.js → http.js) moves its own calls
// out of `except`, and they count.
//   command  { script }  a node script in the family folder; it gets
//            {dir, changes} as JSON on stdin and prints {opportunity, violated, detail}

import path from "node:path";
import { spawnSync } from "node:child_process";

/** A glob ("src/**\/*.js", "test/**", "*.md") as a RegExp over "/" paths. */
export function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      if (glob[i + 2] === "/") {
        re += "(?:.*/)?";
        i += 2;
      } else {
        re += ".*";
        i += 1;
      }
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else if (c === "{") re += "(?:";
    else if (c === "}") re += ")";
    else if (c === "," && re.lastIndexOf("(?:") > re.lastIndexOf(")")) re += "|";
    else re += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

const matchesAny = (globs, p) => (globs ?? []).some((g) => globToRegExp(g).test(p));
const live = (changes) => changes.filter((c) => c.status !== "deleted");

/**
 * A JS line without its comments: `//` and `/* … *\/` outside strings are dropped,
 * and a line that continues a block comment (starts with `*`) is empty. A rule
 * restated in a comment is not a violation of it.
 */
export function stripComments(line) {
  const t = line.trimStart();
  // A block comment's inner line ("* text", "*/"), not code continuing with "* 100".
  if (/^\*(\/|\s*$|\s+[^\d\s(])/.test(t) || (t.startsWith("/*") && !t.includes("*/"))) return "";
  let out = "";
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      out += c;
      if (c === "\\") out += line[++i] ?? "";
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'" || c === "`") {
      quote = c;
      out += c;
    } else if (c === "/" && line[i + 1] === "/") break;
    else if (c === "/" && line[i + 1] === "*") {
      const end = line.indexOf("*/", i + 2);
      if (end === -1) break;
      i = end + 1;
    } else out += c;
  }
  return out;
}

function grepOracle(o, changes) {
  const files = live(changes).filter((c) => matchesAny(o.files, c.path) && !matchesAny(o.except, c.path) && c.added.length);
  const forbid = o.forbid.map((s) => new RegExp(s));
  const hits = [];
  for (const c of files)
    for (const line of c.added) {
      const code = stripComments(line);
      if (forbid.some((r) => r.test(code))) hits.push(`${c.path}: ${line.trim().slice(0, 120)}`);
    }
  return { opportunity: files.length > 0, violated: hits.length > 0, detail: hits.slice(0, 5) };
}

function fileOracle(o, changes) {
  const opportunity = o.opportunity ? live(changes).some((c) => matchesAny(o.opportunity, c.path)) : true;
  const hits = [];
  for (const c of live(changes)) if (matchesAny(o.forbidAdded, c.path)) hits.push(`${c.path} (${c.status})`);
  // confine: an added or changed file matching `files` must be inside `to`.
  if (o.confine) for (const c of live(changes)) if (matchesAny(o.confine.files, c.path) && !matchesAny(o.confine.to, c.path)) hits.push(`${c.path} (outside ${o.confine.to.join(", ")})`);
  for (const c of changes) if (matchesAny(o.unchanged, c.path)) hits.push(`${c.path} (${c.status}, must not change)`);
  return { opportunity, violated: hits.length > 0, detail: hits.slice(0, 5) };
}

function commandOracle(o, changes, { dir, familyDir }) {
  const script = path.resolve(familyDir, o.script);
  if (!script.startsWith(path.resolve(familyDir) + path.sep)) throw new Error(`oracle script outside its family: ${o.script}`);
  const r = spawnSync(process.execPath, [script], { input: JSON.stringify({ dir, changes }), encoding: "utf8", timeout: 60_000, cwd: dir });
  if (r.status !== 0) throw new Error(`oracle ${o.script} failed: ${(r.stderr || r.error?.message || `exit ${r.status}`).trim()}`);
  const out = JSON.parse(r.stdout);
  return { opportunity: Boolean(out.opportunity), violated: Boolean(out.violated), detail: out.detail ?? [] };
}

/**
 * @param {object} oracle  the family's oracle
 * @param {Array} changes  from lib/fixture.mjs changes()
 * @param {{dir: string, familyDir: string}} ctx
 */
export function runOracle(oracle, changes, ctx) {
  const r = oracle.kind === "grep" ? grepOracle(oracle, changes) : oracle.kind === "file" ? fileOracle(oracle, changes) : oracle.kind === "command" ? commandOracle(oracle, changes, ctx) : null;
  if (!r) throw new Error(`unknown oracle kind: ${oracle.kind}`);
  // No opportunity, no violation: the session never touched what the rule governs.
  return r.opportunity ? r : { ...r, violated: false };
}
