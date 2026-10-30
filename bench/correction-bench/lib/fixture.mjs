// A fixture copy for one session, and what the agent changed in it.
//
//   snapshot(dir)        → Map(relative path → text) of every file (no .git,
//                          node_modules or .agent-daemon)
//   changes(before, dir) → [{ path, status: "added"|"modified"|"deleted", added: [lines] }]
//   resetFixture(src, dest, { rules }) → a fresh copy at the SAME path (memory is
//                          keyed by the project's path, so sessions 2…k must reuse it),
//                          a git repo with one commit, plus an optional rules file
//
// Paths use "/" on every OS so oracles and globs read the same everywhere.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const SKIP = new Set([".git", "node_modules", ".agent-daemon"]);

export function snapshot(dir) {
  const out = new Map();
  const walk = (abs, rel) => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      if (SKIP.has(e.name)) continue;
      const a = path.join(abs, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(a, r);
      else if (e.isFile()) out.set(r, fs.readFileSync(a, "utf8").replace(/\r\n/g, "\n"));
    }
  };
  if (fs.existsSync(dir)) walk(dir, "");
  return out;
}

/** Lines in `after` that `before` didn't have (as a multiset: a moved line isn't new). */
export function addedLines(before, after) {
  const left = new Map();
  for (const l of String(before ?? "").split("\n")) left.set(l, (left.get(l) ?? 0) + 1);
  const out = [];
  for (const l of String(after ?? "").split("\n")) {
    const n = left.get(l) ?? 0;
    if (n > 0) left.set(l, n - 1);
    else if (l.trim()) out.push(l);
  }
  return out;
}

export function changes(before, dir) {
  const after = snapshot(dir);
  const out = [];
  for (const [p, text] of after) {
    if (!before.has(p)) out.push({ path: p, status: "added", added: addedLines("", text) });
    else if (before.get(p) !== text) out.push({ path: p, status: "modified", added: addedLines(before.get(p), text) });
  }
  for (const p of before.keys()) if (!after.has(p)) out.push({ path: p, status: "deleted", added: [] });
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

const GIT_ENV = { GIT_AUTHOR_NAME: "bench", GIT_AUTHOR_EMAIL: "bench@example.invalid", GIT_COMMITTER_NAME: "bench", GIT_COMMITTER_EMAIL: "bench@example.invalid", GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z" };

/** The environment without GIT_* (an inherited GIT_DIR would point git at another repository). */
export const withoutGitVars = (env = process.env) => Object.fromEntries(Object.entries(env).filter(([k]) => !/^GIT_/i.test(k)));

function git(cwd, args) {
  const r = spawnSync("git", ["-C", cwd, "-c", "core.autocrlf=false", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args], { cwd, env: { ...withoutGitVars(), ...GIT_ENV }, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args[0]} failed in the fixture: ${(r.stderr || r.error?.message || "").trim()}`);
}

/**
 * Replace `dest` with a fresh copy of `src` (same path every session).
 * @param {{rules?: {file: string, text: string}|null}} [opts] a rules file to add (static-rules)
 */
export function resetFixture(src, dest, { rules = null } = {}) {
  fs.rmSync(dest, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  fs.mkdirSync(dest, { recursive: true });
  fs.cpSync(src, dest, { recursive: true, filter: (p) => !SKIP.has(path.basename(p)) });
  if (rules?.text) fs.writeFileSync(path.join(dest, rules.file), rules.text);
  git(dest, ["init", "-q"]);
  git(dest, ["add", "-A"]);
  git(dest, ["commit", "-q", "-m", "fixture"]);
  return snapshot(dest);
}

/** Write {relative path: text} into `dir` (tests and the mock model use the family's examples). */
export function writeFiles(dir, files) {
  for (const [rel, text] of Object.entries(files ?? {})) {
    const abs = path.join(dir, ...rel.split("/"));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  }
}
