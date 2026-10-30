// The skill library (P5.7): every accepted version of a skill, so accepting a
// proposal applies it, undo works, and `ad init` keeps the user's version.
//
//   ~/.agent-daemon/skills/<name>/
//     current/           the skill folder as published
//     versions/<n>/      each version's folder
//     meta.json          { name, version, sha256, base, baseSha256, bundledSha256,
//                          history: [{ version, sha256, at, action: base|accept|undo, from?, origin?, run?, host?, proposal? }] }
//
// The first accept snapshots the copy hosts load today as version 1 (the project's
// .claude/skills copy, else ~/.claude/skills, else the bundled source). The npm
// package is never edited. History is append-only; undo makes an older version
// current as a new version, so an undo can itself be undone.
//
// Only `ad review` (accept) and `ad skill undo` call the writers here, both behind
// review.mjs's guard (D49); this module asks nothing and trusts its caller for that.

import fs from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { adPackageRoot, adRoot } from "../ad-root.mjs";
import { writeJsonAtomic } from "../atomic-write.mjs";
import { findSecrets } from "../security/secret-patterns.mjs";
import { parseFrontmatter, unquote, validateSkill } from "../skill-lint.mjs";
import { unifiedDiff } from "../text-diff.mjs";
import { isSkillName, parseProposal, PROPOSAL_TEXTS, skillSha, withFrontmatterOf } from "./proposal.mjs";

export const LIBRARY_TEXTS = Object.freeze({
  notInstalled: (name) => `No skill named ${name} is installed or bundled, so there is nothing to update.`,
  drift: (name) => `${name} changed since this proposal was made. Showing the change against today's file.`,
  lint: (first) => `Not applied: the new SKILL.md fails lint: ${first}`,
  secret: (kind) => `Not applied: the new SKILL.md looks like it contains a secret (${kind}).`,
  same: (name) => `${name} already has this content: nothing to apply.`,
  notConfirmed: "Not confirmed: nothing changed.",
  needsSkill: "This lesson doesn't name a skill yet.",
  kept: (name) => `Kept your accepted version of ${name}; this ad release ships a newer one. Compare: ad skill diff ${name} --bundled`,
  noLibrary: (name) => `${name} has no accepted versions to undo.`,
  noVersion: (name, v, max) => `${name} has no version ${v} (1–${max}).`,
  firstVersion: (name) => `${name} is at its first version: nothing to undo.`,
  changedWhileReading: "The proposal or the skill changed while you were reading it, so nothing was applied. Run ad review again to see the change as it is now.",
  hidden: (codes) => `Not applied: the new SKILL.md adds characters a terminal doesn't show (${codes}), so the change can't be reviewed.`,
  publishFailed: (name, v, e) => `✓ ${name} v${v} accepted, but writing it to the hosts failed (${e.code ?? e.message}). Run ad init to refresh Claude Code's copy, and ad skill publish ${name} for the other hosts.`,
  backedUp: (dst, b) => `your edits to ${dst} were backed up to ${b}`,
});

const homeDir = () => process.env.HOME || process.env.USERPROFILE || os.homedir();
const bundledRoot = () => path.join(process.env.AGENT_DAEMON_HOME ? path.resolve(process.env.AGENT_DAEMON_HOME) : path.resolve(adPackageRoot(), ".."), "skills");

export function libraryRoot({ env = process.env } = {}) {
  return path.join(adRoot({ env }), "skills");
}
const libDir = (name, env) => path.join(libraryRoot({ env }), name);

async function defaultBundled() {
  try {
    const { buildSkillIndex } = await import("../skills-source.mjs");
    return await buildSkillIndex(bundledRoot());
  } catch {
    return new Map();
  }
}

/** meta.json of a skill's library entry, or null. */
export function readMeta(name, { env = process.env } = {}) {
  if (!isSkillName(name)) return null;
  try {
    return JSON.parse(readFileSync(path.join(libDir(name, env), "meta.json"), "utf8"));
  } catch {
    return null;
  }
}

/** The library's current folder for a skill: { dir, sha256, meta } or null. */
export function libraryCurrent(name, opts = {}) {
  const meta = readMeta(name, opts);
  if (!meta) return null;
  const dir = path.join(libDir(name, opts.env ?? process.env), "current");
  return existsSync(path.join(dir, "SKILL.md")) ? { dir, sha256: meta.sha256, meta } : null;
}

/** The copy hosts load: { dir, lane: "project"|"global"|"bundled" } or null. */
export function loadedCopy(name, { cwd, home = homeDir(), bundled }) {
  const project = cwd ? path.join(cwd, ".claude", "skills", name) : null;
  if (project && existsSync(path.join(project, "SKILL.md"))) return { dir: project, lane: "project" };
  const global = path.join(home, ".claude", "skills", name);
  if (existsSync(path.join(global, "SKILL.md"))) return { dir: global, lane: "global" };
  const src = bundled?.get(name);
  if (src && existsSync(path.join(src, "SKILL.md"))) return { dir: src, lane: "bundled" };
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function retry(fn, tries = 8) {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      // Windows: a folder another process has open can't be renamed for a moment.
      if (i >= tries || !["EPERM", "EBUSY", "EACCES"].includes(e.code)) throw e;
      await sleep(25 * 2 ** Math.min(i, 5));
    }
  }
}

// Staging lives beside the skills root, never inside it (<root>/../.ad-skill-staging):
// a host scanning its skills folder, even recursively, never sees a half-written or
// leftover copy as a second skill, and the rename stays on one volume. Entries older
// than an hour are swept.
export const STAGING = ".ad-skill-staging";
async function sweepStaging(dir) {
  let names = [];
  try {
    names = await fs.readdir(dir);
  } catch {
    return;
  }
  for (const n of names) {
    try {
      const st = await fs.stat(path.join(dir, n));
      if (Date.now() - st.mtimeMs > 3_600_000) await fs.rm(path.join(dir, n), { recursive: true, force: true });
    } catch {
      // gone already
    }
  }
}

/**
 * Write a skill folder: a copy of `fromDir` (when given) with SKILL.md = `skillMd`,
 * built in the root's staging folder and swapped in, so a reader never sees half a folder.
 */
export async function writeSkillDir(dst, { fromDir, skillMd, extra = {} }) {
  const tag = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const staging = path.join(path.dirname(path.dirname(dst)), STAGING);
  const tmp = path.join(staging, `${path.basename(dst)}-tmp-${tag}`);
  const old = path.join(staging, `${path.basename(dst)}-old-${tag}`);
  await fs.mkdir(path.dirname(dst), { recursive: true });
  await fs.mkdir(staging, { recursive: true });
  await sweepStaging(staging);
  try {
    if (fromDir) await fs.cp(fromDir, tmp, { recursive: true, filter: (p) => path.basename(p) !== STAGING });
    else await fs.mkdir(tmp, { recursive: true });
    if (skillMd !== undefined) await fs.writeFile(path.join(tmp, "SKILL.md"), skillMd);
    for (const [f, text] of Object.entries(extra)) await fs.writeFile(path.join(tmp, f), text);
    const had = existsSync(dst);
    if (had) await retry(() => fs.rename(dst, old));
    try {
      await retry(() => fs.rename(tmp, dst));
    } catch (e) {
      if (had) await fs.rename(old, dst).catch(() => {});
      throw e;
    }
    if (had) await fs.rm(old, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } finally {
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
    await fs.rmdir(staging).catch(() => {}); // only when empty
  }
}

const readText = (p) => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
};
const oneLine = (t) => String(t ?? "").split(/\s+/).filter(Boolean).join(" ");

/** SKILL.md text + a lesson under "## Learned from use" (the section is made at the end if missing). */
export function withLesson(text, lesson, date) {
  const bullet = `- ${oneLine(lesson)} (${date}, ad review)`;
  const nl = /\r\n/.test(text) ? "\r\n" : "\n";
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const at = lines.findIndex((l) => /^## Learned from use\s*$/.test(l));
  let out;
  if (at < 0) out = `${text.replace(/\r\n/g, "\n").trimEnd()}\n\n## Learned from use\n\n${bullet}\n`;
  else {
    let end = lines.findIndex((l, i) => i > at && /^#{1,2} /.test(l));
    if (end < 0) end = lines.length;
    let last = end;
    while (last > at + 1 && lines[last - 1].trim() === "") last--;
    lines.splice(last, 0, bullet);
    out = lines.join("\n").replace(/\n*$/, "\n");
  }
  return nl === "\n" ? out : out.replace(/\n/g, "\r\n");
}

/** Record a resolved proposal in the proposals table (the header of review.mjs says so). */
async function recordProposal(handle, { file, kind, status, diff, run, now }) {
  try {
    const h = handle ?? (await (await import("../memory/episodic.mjs")).db());
    if (!h) return;
    h.run("INSERT INTO proposals (kind, title, description, diff, source_run_id, status, resolved_at) VALUES (?, ?, ?, ?, ?, ?, ?)", [kind, path.basename(file), null, diff ?? null, run ?? null, status, now.toISOString()]);
  } catch {
    // no store: the filed proposal is the record
  }
}

// Move a proposal from proposed/ to applied/ or rejected/, with the outcome in its frontmatter.
async function fileProposal(file, folder, fields) {
  const text = await fs.readFile(file, "utf8");
  const lines = Object.entries(fields).map(([k, v]) => `${k}: ${v}`);
  const nl = /\r\n/.test(text) ? "\r\n" : "\n";
  const front = /^---\r?\n[\s\S]*?(\r?\n)---[ \t]*(\r?\n|$)/.exec(text);
  const next = front ? `${text.slice(0, front.index + front[0].indexOf(`${front[1]}---`))}${nl}${lines.join(nl)}${text.slice(front.index + front[0].indexOf(`${front[1]}---`))}` : `---${nl}${lines.join(nl)}${nl}---${nl}${text}`;
  const dir = path.join(path.dirname(path.dirname(file)), folder);
  await fs.mkdir(dir, { recursive: true });
  const dst = path.join(dir, path.basename(file));
  await fs.writeFile(dst, next);
  await fs.rm(file, { force: true });
  return dst;
}

/**
 * Text for the review screen: control characters (an escape code could hide or redraw
 * what the user confirms) and invisible or direction-changing characters are shown as
 * <U+XXXX>, so the user sees them instead of their effect. Newlines and tabs stay.
 */
const SHOWN_AS_CODE = /(?![\n\t])[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Zl}\p{Zp}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}\u{115F}\u{1160}\u{3164}\u{FFA0}\u{180E}]/gu;
export function visible(text) {
  return String(text ?? "")
    .replace(/\r\n/g, "\n")
    .replace(SHOWN_AS_CODE, (c) => `<U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}>`);
}

// Characters a terminal doesn't show but a model reads (tag characters, direction
// controls, fillers, private and unassigned code points). A change that adds one is
// refused: the user can't review what they can't see. The zero-width joiner and the
// emoji variation selector stay allowed (emoji use them).
const HIDDEN = /[\u{E0000}-\u{E007F}\u{202A}-\u{202E}\u{2066}-\u{2069}\u{200B}\u{200C}\u{200E}\u{200F}\u{061C}\u{2060}-\u{2064}\u{115F}\u{1160}\u{3164}\u{FFA0}\u{180E}\u{FE00}-\u{FE0E}\u{E0100}-\u{E01EF}\p{Co}\p{Cn}\p{Zl}\p{Zp}]/gu;
export function addedHiddenChars(before, after) {
  const count = (t) => (String(t).replace(/^\u{FEFF}/u, "").match(HIDDEN) ?? []).reduce((m, c) => m.set(c, (m.get(c) ?? 0) + 1), new Map());
  const had = count(before);
  // More of a character than before counts too: a copy added next to one already there.
  return [...count(after)].filter(([c, n]) => n > (had.get(c) ?? 0)).map(([c]) => c);
}

// Frontmatter keys that change what a skill may do or when it runs: a change to one
// is called out above the diff.
const RISKY_KEYS = ["name", "allowed-tools", "disallowed-tools", "disable-model-invocation", "user-invocable", "model", "hooks", "shell", "context", "agent", "paths"];
// A key's whole value in the frontmatter: its own line plus the indented or list lines
// under it (a YAML block: allowed-tools as a list, hooks as a map). null when absent.
function frontmatterValue(text, key) {
  const m = /^\u{FEFF}?---\r?\n([\s\S]*?)\r?\n---/u.exec(String(text));
  if (!m) return null;
  const lines = m[1].split(/\r?\n/);
  const at = lines.findIndex((l) => l.startsWith(`${key}:`));
  if (at < 0) return null;
  const out = [lines[at].slice(key.length + 1).trim()];
  for (const l of lines.slice(at + 1)) {
    if (/^[^\s#-][^:]*:/.test(l)) break;
    out.push(l.trimEnd());
  }
  return out.join("\n").trim();
}
/** The first top-level frontmatter key that appears twice, or null. */
export function repeatedFrontmatterKey(text) {
  const m = /^\u{FEFF}?---\r?\n([\s\S]*?)\r?\n---/u.exec(String(text));
  if (!m) return null;
  const seen = new Set();
  for (const l of m[1].split(/\r?\n/)) {
    const k = /^([^\s#-][^:]*):/.exec(l)?.[1].trim();
    if (!k) continue;
    if (seen.has(k)) return k;
    seen.add(k);
  }
  return null;
}
function frontmatterWarnings(current, next) {
  const show = (v) => (v === null ? "(none)" : v.replace(/\s*\n\s*/g, " "));
  return RISKY_KEYS.filter((k) => frontmatterValue(current, k) !== frontmatterValue(next, k)).map((k) => `This change edits the skill's ${k}: ${JSON.stringify(show(frontmatterValue(current, k)))} → ${JSON.stringify(show(frontmatterValue(next, k)))}`);
}

/**
 * What accepting a proposal would change, for the review screen:
 * → { ok:true, name, kind, legacy, current, next, diff, loaded } | { ok:false, text, needsSkill? }
 */
export async function previewSkillProposal(file, { cwd, home = homeDir(), bundled, lessonSkill, now = new Date() } = {}) {
  const parsed = parseProposal(await fs.readFile(file, "utf8"));
  if (parsed.error) return { ok: false, text: parsed.error };
  if (parsed.legacy === "unknown") return { ok: false, text: PROPOSAL_TEXTS.oldFormat };
  const meta = parsed.meta;
  const name = meta.kind === "skill-lesson" ? (meta.skill ?? lessonSkill) : meta.skill;
  if (!name) return { ok: false, needsSkill: true, text: LIBRARY_TEXTS.needsSkill };
  if (!isSkillName(name)) return { ok: false, text: PROPOSAL_TEXTS.badName };
  bundled ??= await defaultBundled();
  const loaded = loadedCopy(name, { cwd, home, bundled });
  if (!loaded) return { ok: false, text: LIBRARY_TEXTS.notInstalled(name) };
  const current = readText(path.join(loaded.dir, "SKILL.md")) ?? "";
  let next;
  if (meta.kind === "skill-lesson") next = withLesson(current, parsed.body, now.toISOString().slice(0, 10));
  else next = parsed.bodyOnly ? withFrontmatterOf(current, parsed.body) : parsed.body;
  const drift = meta.kind === "skill-update" && !parsed.legacy && meta["base-sha256"] !== skillSha(current);
  const diff = (color = false) => unifiedDiff(visible(current), visible(next), { from: `${name} (today)`, to: `${name} (proposed)`, color });
  return { ok: true, name, kind: meta.kind, legacy: parsed.legacy, meta, current, next, loaded, bundled, drift, warnings: frontmatterWarnings(current, next), diff: diff(), diffFor: diff, expect: { current: skillSha(current), next: skillSha(next) } };
}

/**
 * Apply a skill proposal: checks, a new library version, publish, file the proposal.
 * confirmDrift(text) and confirmLegacy() decide the two extra confirmations (default: no).
 * expect: { current, next } checksums of what the user was shown; when the proposal or
 * the skill changed since, nothing is applied (the user confirms what they read).
 * → { ok, text, version?, needsSkill? }
 */
export async function applySkillProposal(file, opts = {}) {
  const { cwd, home = homeDir(), env = process.env, now = new Date(), handle = null, expect, confirmDrift = async () => false, confirmLegacy = async () => false } = opts;
  const p = await previewSkillProposal(file, { ...opts, home, now });
  if (!p.ok) return p;
  const { name } = p;
  if (expect && (expect.current !== p.expect.current || expect.next !== p.expect.next)) return { ok: false, text: LIBRARY_TEXTS.changedWhileReading };
  if (p.drift && !(await confirmDrift(`${LIBRARY_TEXTS.drift(name)}\n${p.diff}`))) return { ok: false, text: LIBRARY_TEXTS.notConfirmed };
  if (p.legacy && !(await confirmLegacy())) return { ok: false, text: LIBRARY_TEXTS.notConfirmed };
  if (skillSha(p.next) === skillSha(p.current)) return { ok: false, text: LIBRARY_TEXTS.same(name) };
  const lintError = validateSkill(name, p.next).find((i) => i.severity === "error");
  if (lintError) return { ok: false, text: LIBRARY_TEXTS.lint(lintError.message) };
  // A renamed skill would shadow another one in hosts that load by name.
  const declared = unquote(parseFrontmatter(p.next)?.fields?.name ?? "");
  if (declared !== name) return { ok: false, text: LIBRARY_TEXTS.lint(`name "${declared}" must stay "${name}" (the folder's name)`) };
  // A repeated key: YAML parsers take the last one, so a second allowed-tools could hide
  // behind the first, which is the one the warnings compare.
  const repeated = repeatedFrontmatterKey(p.next);
  if (repeated) return { ok: false, text: LIBRARY_TEXTS.lint(`the frontmatter repeats \`${repeated}\``) };
  const hidden = addedHiddenChars(p.current, p.next);
  if (hidden.length) return { ok: false, text: LIBRARY_TEXTS.hidden(hidden.map((c) => `U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}`).join(", ")) };
  const secret = findSecrets(p.next)[0];
  if (secret) return { ok: false, text: LIBRARY_TEXTS.secret(secret.kind) };

  const version = await commitVersion(name, { fromDir: p.loaded.dir, skillMd: p.next, base: p.loaded, bundled: p.bundled, env, now, entry: { action: "accept", origin: p.meta.origin ?? (p.legacy || null), run: p.meta.run, host: p.meta.host, proposal: path.basename(file) } });
  // The version is accepted whatever happens next: a failed write is reported, and the
  // proposal is still filed, so accepting it again can't make a second version.
  let hosts;
  let failed = null;
  try {
    hosts = await publish(name, { home, env, loaded: p.loaded, now });
  } catch (e) {
    failed = e;
  }
  await fileProposal(file, "applied", { resolved: "accepted", version });
  await recordProposal(handle, { file, kind: p.kind, status: "accepted", diff: p.diff, run: p.meta.run, now });
  if (failed) return { ok: true, version, hosts: [], text: LIBRARY_TEXTS.publishFailed(name, version, failed) };
  return { ok: true, version, hosts, text: `✓ ${name} v${version} accepted and published to: ${hosts.join(", ")}. Undo: ad skill undo ${name}` };
}

/** Reject: the file goes to rejected/ (kept as evidence) and the proposals table says so. */
export async function rejectSkillProposal(file, { handle = null, now = new Date() } = {}) {
  const parsed = parseProposal(await fs.readFile(file, "utf8"));
  const dst = await fileProposal(file, "rejected", { resolved: "rejected" });
  await recordProposal(handle, { file, kind: parsed.meta?.kind ?? "skill-update", status: "rejected", run: parsed.meta?.run, now });
  return dst;
}

// A new library version: the base snapshot first (version 1) when there is no entry yet.
async function commitVersion(name, { fromDir, skillMd, base, bundled, env, now, entry }) {
  const dir = libDir(name, env);
  let meta = readMeta(name, { env });
  const at = now.toISOString();
  if (!meta) {
    const baseText = readText(path.join(base.dir, "SKILL.md")) ?? "";
    const bundledText = bundled?.get(name) ? readText(path.join(bundled.get(name), "SKILL.md")) : null;
    await writeSkillDir(path.join(dir, "versions", "1"), { fromDir: base.dir });
    meta = { name, version: 1, sha256: skillSha(baseText), base: base.lane === "bundled" ? "bundled" : "installed", baseSha256: skillSha(baseText), bundledSha256: bundledText === null ? null : skillSha(bundledText), history: [{ version: 1, sha256: skillSha(baseText), at, action: "base" }] };
  }
  const version = meta.version + 1;
  await writeSkillDir(path.join(dir, "versions", String(version)), { fromDir, skillMd });
  await writeSkillDir(path.join(dir, "current"), { fromDir: path.join(dir, "versions", String(version)) });
  const clean = Object.fromEntries(Object.entries(entry).filter(([, v]) => v !== undefined && v !== null));
  meta = { ...meta, version, sha256: skillSha(skillMd ?? readText(path.join(dir, "current", "SKILL.md"))), history: [...meta.history, { version, sha256: skillSha(skillMd ?? readText(path.join(dir, "current", "SKILL.md"))), at, ...clean }] };
  await fs.mkdir(dir, { recursive: true });
  await writeJsonAtomic(path.join(dir, "meta.json"), meta);
  return version;
}

/**
 * Publish the library's current version: the copy Claude Code loads (ad's engine
 * follows it through its mirror), then skills/publish.mjs. → host names, for the message.
 */
async function publish(name, { home, env, loaded, now = new Date() }) {
  const cur = libraryCurrent(name, { env });
  const dst = loaded && loaded.lane !== "bundled" ? loaded.dir : path.join(home, ".claude", "skills", name);
  // A copy that is no version of ours was edited by hand since: keep it in a backup.
  const onDisk = readText(path.join(dst, "SKILL.md"));
  let backedUp = null;
  if (onDisk !== null && !cur.meta.history.some((h) => h.sha256 === skillSha(onDisk))) {
    backedUp = path.join(adRoot({ env, homedir: () => home }), "memory", "backups", "claude-code", `${now.toISOString().replace(/[:.]/g, "-")}-${name}`);
    await fs.mkdir(path.dirname(backedUp), { recursive: true });
    await fs.cp(dst, backedUp, { recursive: true, filter: (p) => path.basename(p) !== STAGING });
  }
  await writeSkillDir(dst, { fromDir: cur.dir });
  // ad's engine reads Claude Code's folder (its mirror); then every installed host.
  const hosts = [backedUp ? `Claude Code (${LIBRARY_TEXTS.backedUp(dst, backedUp)})` : "Claude Code", "ad"];
  const { publishToHosts } = await import("./publish.mjs");
  for (const r of await publishToHosts(name, { home, env })) {
    if (r.status === "written") hosts.push(r.label);
    else if (r.status === "edited") hosts.push(`not ${r.label} (changed outside ad: ad skill publish ${name} --host ${r.id} --replace)`);
  }
  return hosts;
}

/**
 * `ad skill undo <name> [--to n]`: make an older version current as a new version,
 * then publish it. Guarded by the caller (D49).
 */
export async function undoSkill(name, { to, cwd, home = homeDir(), env = process.env, now = new Date(), bundled } = {}) {
  const meta = readMeta(name, { env });
  if (!meta) return { ok: false, text: LIBRARY_TEXTS.noLibrary(name) };
  const target = to === undefined ? meta.version - 1 : Number(to);
  if (to === undefined && target < 1) return { ok: false, text: LIBRARY_TEXTS.firstVersion(name) };
  if (!Number.isInteger(target) || target < 1 || target > meta.version) return { ok: false, text: LIBRARY_TEXTS.noVersion(name, to, meta.version) };
  const from = path.join(libDir(name, env), "versions", String(target));
  bundled ??= await defaultBundled();
  const loaded = loadedCopy(name, { cwd, home, bundled });
  const version = await commitVersion(name, { fromDir: from, skillMd: readText(path.join(from, "SKILL.md")), base: loaded, bundled, env, now, entry: { action: "undo", from: target } });
  let hosts;
  try {
    hosts = await publish(name, { home, env, loaded, now });
  } catch (e) {
    return { ok: true, version, hosts: [], text: LIBRARY_TEXTS.publishFailed(name, version, e) };
  }
  return { ok: true, version, hosts, text: `✓ ${name} v${version} (the content of v${target}) is current; published to: ${hosts.join(", ")}.` };
}

export function skillHistory(name, opts = {}) {
  return readMeta(name, opts)?.history ?? [];
}

/** `ad skill diff <name> [--from a] [--to b] [--bundled]`. */
export async function skillDiff(name, { from, to, bundled: compareBundled = false, env = process.env, bundled } = {}) {
  const meta = readMeta(name, { env });
  if (!meta) return null;
  const v = (n) => readText(path.join(libDir(name, env), "versions", String(n), "SKILL.md")) ?? "";
  if (compareBundled) {
    bundled ??= await defaultBundled();
    const src = bundled.get(name);
    return unifiedDiff(v(meta.version), src ? (readText(path.join(src, "SKILL.md")) ?? "") : "", { from: `${name} v${meta.version} (yours)`, to: `${name} (this ad release)` });
  }
  const b = to ?? meta.version;
  const a = from ?? Math.max(1, b - 1);
  return unifiedDiff(v(a), v(b), { from: `${name} v${a}`, to: `${name} v${b}` });
}

/**
 * For `ad init` (skill-install.mjs installSkillLane): how a lane should treat a skill
 * that has a library entry. → null (no entry: the usual rule) |
 *   { action: "install"|"replace"|"keep", dir, notice? }
 */
export function laneDecision(name, dest, srcDir, opts = {}) {
  const cur = libraryCurrent(name, opts);
  if (!cur) return null;
  const bundledText = srcDir ? readText(path.join(srcDir, "SKILL.md")) : null;
  const notice = bundledText !== null && cur.meta.bundledSha256 && skillSha(bundledText) !== cur.meta.bundledSha256 ? LIBRARY_TEXTS.kept(name) : undefined;
  const destText = readText(path.join(dest, "SKILL.md"));
  if (destText === null) return { action: "install", dir: cur.dir, notice };
  const sha = skillSha(destText);
  if (sha === cur.sha256) return { action: "keep", dir: cur.dir, notice };
  // An older version of ours: bring it up to date. Anything else was edited by hand: leave it.
  if (cur.meta.history.some((h) => h.sha256 === sha)) return { action: "replace", dir: cur.dir, notice };
  return { action: "keep", dir: cur.dir, notice };
}
