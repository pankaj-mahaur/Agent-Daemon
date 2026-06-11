// On-demand skill installation (`ad skill install|list|remove|search`).
//
// Sources:
//   - bundled name     → resolved against this repo's skills/ (buckets aware)
//   - local path       → a dir containing SKILL.md, or a multi-skill folder
//   - git URL          → shallow clone to a tmp dir (https/git@/ssh only — the
//                        anchor prevents C:\ paths from being mistaken for URLs)
//
// Security posture: copy-only (no code executes at install time), lint-gated
// via skill-lint.mjs (errors block unless force), provenance recorded to
// ~/.agent-daemon/skill-manifest.json (source ref + sha256), no auto-update.
// Route maps recompile after every install/remove so the routing hook sees
// the change immediately.

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { buildSkillIndex, resolveSkillSource } from "./skills-source.mjs";
import { parseFrontmatter, validateSkill, unquote } from "./skill-lint.mjs";
import { rebuildRouteMaps } from "./route-map.mjs";

// file:// included for local-repo installs and tests; C:\ paths can't match
// because the alternatives are anchored to URL schemes.
const GIT_URL_RE = /^(https?:\/\/|git@|ssh:\/\/|file:\/\/)/;
const BUNDLED_NAME_RE = /^[a-z][a-z0-9-]*$/;

function homeDir() {
  return process.env.HOME || process.env.USERPROFILE || ".";
}

function manifestPath() {
  return path.join(homeDir(), ".agent-daemon", "skill-manifest.json");
}

/* ------------------------------------------------------------------ */
/* Lane install (shared with `ad init`)                                */
/* ------------------------------------------------------------------ */

/**
 * Install a set of skills into one lane dir. Idempotency rules:
 *   - dest missing    → copy
 *   - source newer    → overwrite (1s mtime tolerance)
 *   - same/older      → skip
 *
 * @param {string[]} skillNames
 * @param {Map<string, string>} skillIndex - name → source dir
 * @param {string} destRoot
 * @returns {Promise<{installed: number, updated: number, skipped: number, missing: number}>}
 */
export async function installSkillLane(skillNames, skillIndex, destRoot) {
  let installed = 0, updated = 0, skipped = 0, missing = 0;
  try {
    await fs.mkdir(destRoot, { recursive: true });
  } catch { return { installed, updated, skipped, missing }; }

  for (const skill of skillNames) {
    const src = skillIndex.get(skill);
    if (!src) { missing++; continue; }
    const dst = path.join(destRoot, skill);
    let destExists = false;
    try { await fs.access(dst); destExists = true; } catch { /* not installed */ }

    if (!destExists) {
      try { await fs.cp(src, dst, { recursive: true }); installed++; }
      catch { /* copy failed — skip silently */ }
      continue;
    }

    // dest exists — compare mtime of SKILL.md to decide update vs skip
    try {
      const [srcStat, dstStat] = await Promise.all([
        fs.stat(path.join(src, "SKILL.md")),
        fs.stat(path.join(dst, "SKILL.md"))
      ]);
      if (srcStat.mtimeMs > dstStat.mtimeMs + 1000) {  // 1s tolerance for fs precision
        try {
          await fs.rm(dst, { recursive: true, force: true });
          await fs.cp(src, dst, { recursive: true });
          updated++;
        } catch { /* update failed — skip */ }
      } else {
        skipped++;
      }
    } catch {
      // stat failed — leave as-is
      skipped++;
    }
  }
  return { installed, updated, skipped, missing };
}

/* ------------------------------------------------------------------ */
/* Source resolution                                                   */
/* ------------------------------------------------------------------ */

/**
 * Resolve an install spec to one or more skill source dirs.
 *
 * @param {string} spec - bundled name | local path | git URL
 * @param {{ projectRoot: string, skillFilter?: string }} opts
 * @returns {Promise<{ type: string, skills: Map<string, string>, sourceRef: string, cleanup: () => Promise<void> }>}
 */
export async function resolveInstallSource(spec, { projectRoot, skillFilter }) {
  const noop = async () => {};

  // Git URL — shallow clone, then index the clone like a local path.
  if (GIT_URL_RE.test(spec)) {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ad-skill-git-"));
    const clone = await runGit(["clone", "--depth", "1", spec, tmp]);
    if (clone.code !== 0) {
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
      throw new Error(`git clone failed: ${clone.err || clone.out || `exit ${clone.code}`}`);
    }
    const head = await runGit(["-C", tmp, "rev-parse", "HEAD"]);
    const sourceRef = `${spec}@${(head.out || "unknown").trim().slice(0, 12)}`;
    const skills = await indexLocalSource(tmp, skillFilter);
    return {
      type: "git",
      skills,
      sourceRef,
      cleanup: async () => { await fs.rm(tmp, { recursive: true, force: true }).catch(() => {}); }
    };
  }

  // Existing local path — single skill dir or multi-skill folder.
  let isDir = false;
  try { isDir = (await fs.stat(spec)).isDirectory(); } catch { /* not a path */ }
  if (isDir) {
    const abs = path.resolve(spec);
    return { type: "path", skills: await indexLocalSource(abs, skillFilter), sourceRef: abs, cleanup: noop };
  }

  // Bundled name from this repo's skills/.
  if (BUNDLED_NAME_RE.test(spec)) {
    const src = await resolveSkillSource(path.join(projectRoot, "skills"), spec);
    if (src) {
      return { type: "bundled", skills: new Map([[spec, src]]), sourceRef: `bundled:${spec}`, cleanup: noop };
    }
    throw new Error(`no bundled skill named "${spec}" — try: ad skill search ${spec}`);
  }

  throw new Error(`cannot resolve install source "${spec}" (expected a bundled skill name, an existing directory, or a git URL)`);
}

/**
 * Index a local dir: if it IS a skill (has SKILL.md), one entry; otherwise
 * treat as a multi-skill folder via buildSkillIndex. skillFilter narrows
 * multi-skill sources.
 */
async function indexLocalSource(dir, skillFilter) {
  let hasSkillMd = false;
  try { await fs.access(path.join(dir, "SKILL.md")); hasSkillMd = true; } catch { /* folder of skills */ }

  if (hasSkillMd) {
    const content = await fs.readFile(path.join(dir, "SKILL.md"), "utf8");
    const name = unquote(parseFrontmatter(content)?.fields?.name || "") || path.basename(dir);
    return new Map([[name, dir]]);
  }

  let index = await buildSkillIndex(dir);
  // Repos commonly nest skills under skills/ — fall through when the root has none.
  if (index.size === 0) {
    try { index = await buildSkillIndex(path.join(dir, "skills")); } catch { /* none */ }
  }
  if (skillFilter) {
    const hit = index.get(skillFilter);
    return hit ? new Map([[skillFilter, hit]]) : new Map();
  }
  return index;
}

function runGit(args) {
  return new Promise((resolve) => {
    const child = spawn("git", args, { stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" });
    let out = "", err = "";
    child.stdout.on("data", c => out += c);
    child.stderr.on("data", c => err += c);
    child.on("close", code => resolve({ code, out: out.trim(), err: err.trim() }));
    child.on("error", e => resolve({ code: -1, out: "", err: e.message }));
  });
}

/* ------------------------------------------------------------------ */
/* Lint gate                                                           */
/* ------------------------------------------------------------------ */

/**
 * Validate an install candidate. Vendored skills (source:/origin: present)
 * get the relaxed treatment lint-skills gives them — frontmatter + name are
 * still required.
 *
 * @param {string} name
 * @param {string} content
 * @returns {{ errors: string[], warnings: string[] }}
 */
export function lintInstallCandidate(name, content) {
  const parsed = parseFrontmatter(content);
  if (!parsed) return { errors: ["missing frontmatter (no --- delimiters)"], warnings: [] };

  const vendored = /^(source|origin):\s*\S/m.test(content);
  const issues = validateSkill(name, content);
  const errors = [];
  const warnings = [];
  for (const issue of issues) {
    // Vendored relaxation: description-style errors become warnings (their
    // upstream conventions differ); structural errors (missing name) stay.
    if (vendored && issue.severity === "error" && /description/.test(issue.message)) {
      warnings.push(issue.message);
    } else if (issue.severity === "error") {
      errors.push(issue.message);
    } else {
      warnings.push(issue.message);
    }
  }
  return { errors, warnings };
}

/* ------------------------------------------------------------------ */
/* Install / remove / list / search                                    */
/* ------------------------------------------------------------------ */

/**
 * @param {{ name: string, srcDir: string, lane: 'global'|'project', cwd: string, sourceType: string, sourceRef: string, force?: boolean, dryRun?: boolean }} opts
 * @returns {Promise<{ ok: boolean, dest?: string, errors?: string[], warnings?: string[], note?: string }>}
 */
export async function installSkill(opts) {
  const { name, srcDir, lane, cwd, force, dryRun } = opts;
  const content = await fs.readFile(path.join(srcDir, "SKILL.md"), "utf8");

  const { errors, warnings } = lintInstallCandidate(name, content);
  if (errors.length > 0 && !force) {
    return { ok: false, errors, warnings, note: "lint errors block install — fix the frontmatter or pass --force" };
  }

  const dest = lane === "project"
    ? path.join(cwd, ".claude", "skills", name)
    : path.join(homeDir(), ".claude", "skills", name);

  let exists = false;
  try { await fs.access(dest); exists = true; } catch { /* fresh */ }
  if (exists && !force) {
    return { ok: false, errors: [`"${name}" is already installed at ${dest}`], warnings, note: "use --force to overwrite, or `ad init` to refresh bundled skills" };
  }

  if (dryRun) {
    return { ok: true, dest, warnings, note: `dry-run — would ${exists ? "overwrite" : "install"} ${dest}` };
  }

  if (exists) await fs.rm(dest, { recursive: true, force: true });
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.cp(srcDir, dest, { recursive: true });

  await recordProvenance({
    name,
    lane,
    dest,
    sourceType: opts.sourceType,
    sourceRef: opts.sourceRef,
    skillMdSha256: crypto.createHash("sha256").update(content).digest("hex")
  });

  // Routing hook picks the new skill up on its next fire.
  try { await rebuildRouteMaps({ home: homeDir(), cwd }); } catch { /* best-effort */ }

  return { ok: true, dest, warnings };
}

/**
 * Remove an installed skill. Manifest-managed installs remove cleanly;
 * unmanaged dirs (hand-authored) require force.
 *
 * @param {{ name: string, lane: 'global'|'project', cwd: string, force?: boolean }} opts
 * @returns {Promise<{ ok: boolean, note: string }>}
 */
export async function removeSkill({ name, lane, cwd, force }) {
  const dest = lane === "project"
    ? path.join(cwd, ".claude", "skills", name)
    : path.join(homeDir(), ".claude", "skills", name);

  try { await fs.access(dest); } catch {
    return { ok: false, note: `"${name}" is not installed in the ${lane} lane (${dest})` };
  }

  const manifest = await readManifest();
  const managed = manifest.installs.some(i => i.name === name && i.dest === dest);
  if (!managed && !force) {
    return { ok: false, note: `"${name}" was not installed by agent-daemon (no manifest entry) — it may be hand-authored. Pass --force to remove anyway.` };
  }

  await fs.rm(dest, { recursive: true, force: true });
  manifest.installs = manifest.installs.filter(i => !(i.name === name && i.dest === dest));
  await writeManifest(manifest);
  try { await rebuildRouteMaps({ home: homeDir(), cwd }); } catch { /* best-effort */ }
  return { ok: true, note: `removed ${dest}` };
}

/**
 * List installed skills across both lanes, joined with manifest provenance.
 *
 * @param {{ cwd: string, projectRoot: string, available?: boolean }} opts
 * @returns {Promise<Array<{name: string, lane: string, source: string, description: string}>>}
 */
export async function listSkills({ cwd, projectRoot, available }) {
  if (available) {
    const index = await buildSkillIndex(path.join(projectRoot, "skills"));
    let installedGlobal = new Map();
    try { installedGlobal = await buildSkillIndex(path.join(homeDir(), ".claude", "skills")); } catch { /* none */ }
    const out = [];
    for (const [name, dir] of [...index].sort((a, b) => a[0].localeCompare(b[0]))) {
      out.push({
        name,
        lane: installedGlobal.has(name) ? "installed" : "available",
        source: "bundled",
        description: await firstSentence(dir)
      });
    }
    return out;
  }

  const manifest = await readManifest();
  const provenance = new Map(manifest.installs.map(i => [i.dest, i]));
  const lanes = [
    { lane: "global", dir: path.join(homeDir(), ".claude", "skills") },
    { lane: "project", dir: path.join(cwd, ".claude", "skills") }
  ];
  const out = [];
  for (const { lane, dir } of lanes) {
    let index;
    try { index = await buildSkillIndex(dir); } catch { continue; }
    for (const [name, skillDir] of [...index].sort((a, b) => a[0].localeCompare(b[0]))) {
      const prov = provenance.get(skillDir);
      out.push({
        name,
        lane,
        source: prov ? `${prov.sourceType}:${prov.sourceRef}`.slice(0, 60) : "(unmanaged)",
        description: await firstSentence(skillDir)
      });
    }
  }
  return out;
}

async function firstSentence(skillDir) {
  try {
    const content = await fs.readFile(path.join(skillDir, "SKILL.md"), "utf8");
    const desc = unquote(parseFrontmatter(content)?.fields?.description || "");
    return (desc.split(/(?<=[.!?])\s/)[0] || desc).slice(0, 100);
  } catch {
    return "";
  }
}

/**
 * Substring search over the bundled skill index (names + descriptions).
 *
 * @param {{ query: string, projectRoot: string }} opts
 * @returns {Promise<Array<{name: string, installed: boolean, description: string}>>}
 */
export async function searchSkills({ query, projectRoot }) {
  const q = String(query || "").toLowerCase();
  if (!q) return [];
  const index = await buildSkillIndex(path.join(projectRoot, "skills"));
  let installed = new Map();
  try { installed = await buildSkillIndex(path.join(homeDir(), ".claude", "skills")); } catch { /* none */ }

  const out = [];
  for (const [name, dir] of [...index].sort((a, b) => a[0].localeCompare(b[0]))) {
    const desc = await firstSentence(dir);
    if (name.toLowerCase().includes(q) || desc.toLowerCase().includes(q)) {
      out.push({ name, installed: installed.has(name), description: desc });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Provenance manifest                                                 */
/* ------------------------------------------------------------------ */

export async function readManifest() {
  try {
    const doc = JSON.parse(await fs.readFile(manifestPath(), "utf8"));
    if (doc && Array.isArray(doc.installs)) return doc;
  } catch { /* fresh */ }
  return { schema_version: 1, installs: [] };
}

async function writeManifest(manifest) {
  await fs.mkdir(path.dirname(manifestPath()), { recursive: true });
  await fs.writeFile(manifestPath(), JSON.stringify(manifest, null, 2), "utf8");
}

async function recordProvenance(entry) {
  const manifest = await readManifest();
  const now = new Date().toISOString();
  const existing = manifest.installs.find(i => i.name === entry.name && i.dest === entry.dest);
  if (existing) {
    Object.assign(existing, entry, { installedAt: existing.installedAt, updatedAt: now });
  } else {
    manifest.installs.push({ ...entry, installedAt: now, updatedAt: now });
  }
  await writeManifest(manifest);
}
