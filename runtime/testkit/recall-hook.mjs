// Spawned-hook helpers for L6's end-to-end tests: a temp HOME and ad root, a git
// project with a branch, a seeded store, and the dispatcher run as a host runs it.
// The caller sets process.env.HOME/USERPROFILE/AD_ROOT before importing this module.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

export const HOOK = fileURLToPath(new URL("../bin/hook.mjs", import.meta.url));

export function git(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" } });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}
export const hasGit = spawnSync("git", ["--version"], { windowsHide: true }).status === 0;

/** A git project on `branch` with one commit. */
export function gitProject(dir, branch = "main") {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", branch);
  fs.writeFileSync(path.join(dir, "README.md"), "x\n");
  git(dir, "add", "README.md");
  git(dir, "commit", "-q", "-m", "first");
  return dir;
}

/** The project's memory keys, as the hook computes them, and a seeding function. */
export async function projectStore(project) {
  const { hookProjectKeys } = await import("../src/memory/scope.mjs");
  const ep = await import("../src/memory/episodic.mjs");
  const keys = await hookProjectKeys(project);
  const handle = await ep.db();
  const slug = keys.find((k) => !k.startsWith("prj_"));
  const id = keys.find((k) => k.startsWith("prj_")) ?? null;
  // A content hash per project and text, as the writers set one: a row without it is
  // backfilled on the next open, and the 3.0 backfill drops same-text rows store-wide.
  const add = (o) => {
    const row = { project_slug: slug, category: "correction", status: "active", accepted_by: "review", provenance: "legacy", content_hash: crypto.createHash("sha256").update(`${slug}\0${o.text}`).digest("hex").slice(0, 16), ...o };
    if (row.status !== "active" && row.status !== "forget-requested" && !("accepted_by" in o)) row.accepted_by = null;
    const cols = Object.keys(row);
    handle.run(`INSERT INTO learnings (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`, cols.map((c) => row[c]));
    return handle.get("SELECT last_insert_rowid() AS id").id;
  };
  return { keys, slug, id, handle, add, close: () => ep.closeDb() };
}

/**
 * Run the dispatcher. host: "claude" (a Claude Code hook: CLAUDE_PROJECT_DIR set, no
 * flag), "codex" (--host codex, a Codex payload), "plugin" (--plugin), "memory-only"
 * (the product launcher's --memory-only under Claude Code), "unknown" (no signal).
 */
export function runHook(event, payload, { host = "claude", project, env = {}, preload = null } = {}) {
  const args = [HOOK, event];
  const e = { ...process.env, ...env };
  for (const k of ["CLAUDE_PROJECT_DIR", "AD_HOOK_HOST", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ATTENDED", "AD_WORKER", "CLAUDE_CONFIG_DIR", "CODEX_HOME"]) if (!(k in env)) delete e[k];
  if (host === "claude" || host === "memory-only") e.CLAUDE_PROJECT_DIR = project;
  if (host === "codex") args.push("--host", "codex");
  if (host === "plugin") args.push("--plugin");
  if (host === "memory-only") args.push("--memory-only");
  const r = spawnSync(process.execPath, [...(preload ? ["--import", pathToFileURL(preload).href] : []), ...args], { input: JSON.stringify(payload), env: e, encoding: "utf8", timeout: 60_000, windowsHide: true });
  let out = {};
  try {
    out = JSON.parse(r.stdout || "{}");
  } catch {
    out = { raw: r.stdout };
  }
  return { status: r.status, stderr: r.stderr, out, context: out?.hookSpecificOutput?.additionalContext ?? "", message: out?.systemMessage ?? "" };
}

export const sessionStart = (project, session, extra = {}) => ({ session_id: session, cwd: project, hook_event_name: "SessionStart", source: "startup", transcript_path: path.join(project, "t.jsonl"), ...extra });
export const codexSessionStart = (project, session) => ({ session_id: session, turn_id: "t1", cwd: project, hook_event_name: "SessionStart", source: "startup", model: "x" });

/** The learning ids in a block's note lines ("- #12 …"). */
export const idsIn = (text) => [...String(text).matchAll(/^- #(\d+)\b/gm)].map((m) => Number(m[1]));
