// Publishing accepted skills to the hosts ad's memory is installed in (P5.7b).
//
// Targets: every host in the install ledger (memory-install/ledger.mjs) that has a
// folder of its own (hosts/skill-formats.mjs: Codex, Gemini CLI); `ad memory install`
// for a host is the user's consent to ad's folders there. Claude Code is ad init's
// lane, written by the library itself; OpenCode, VS Code and Cursor read that folder.
// ~/.agents/skills only when the user names it (--host agents).
//
// Each published folder holds .ad-skill.json { name, version, sha256, publishedAt }:
// ad's ownership marker. A folder with no marker, or whose SKILL.md changed since ad
// wrote it, is never overwritten unless --replace, which backs it up first
// (adRoot/memory/backups/<host>/). The ledger's host entry records
// skills: { <name>: { version, sha256, path } }, so uninstall removes only our folders.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { adRoot } from "../ad-root.mjs";
import { readLedger, writeLedger } from "../memory-install/ledger.mjs";
import { writeJsonAtomic } from "../atomic-write.mjs";
import { SKILL_TARGETS, userSkillRoot } from "../hosts/skill-formats.mjs";
import { libraryCurrent, libraryRoot, writeSkillDir } from "./library.mjs";
import { isSkillName, skillSha } from "./proposal.mjs";

export const MARKER = ".ad-skill.json";
export const PUBLISH_TEXTS = Object.freeze({
  edited: (label, p, name, id) => `${label}: ${p} was changed outside ad, so it wasn't overwritten. Keep it, or run: ad skill publish ${name} --host ${id} --replace`,
  notInstalled: (label, id) => `${label}: ad's memory isn't installed there (ad memory install --host ${id})`,
  via: (label) => `${label}: reads Claude Code's skills folder, so it already has it`,
  viaTwice: (label) => `${label}: reads Claude Code's skills folder and Codex's, so it may list the skill twice`,
  duplicate: "Every host but Claude Code reads ~/.agents/skills as well as its own folder or Claude Code's, so they may list the skill twice.",
});

const homeDir = () => process.env.HOME || process.env.USERPROFILE || os.homedir();
const readJson = (p) => {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
};

/** Is `dir` a folder ad published and nobody changed since? */
export function ownedUnchanged(dir) {
  const marker = readJson(path.join(dir, MARKER));
  if (!marker) return false;
  try {
    return skillSha(fs.readFileSync(path.join(dir, "SKILL.md"), "utf8")) === marker.sha256;
  } catch {
    return false;
  }
}

function backupDir(root, host, dir, now) {
  const dest = path.join(root, "memory", "backups", host, `${now.toISOString().replace(/[:.]/g, "-")}-${path.basename(dir)}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(dir, dest, { recursive: true, errorOnExist: true, force: false });
  return dest;
}

/**
 * Publish one accepted skill. → [{ id, label, status, path?, text? }]
 * status: written | edited | not-installed | via | dry-run | replaced
 * @param {{ home?: string, env?: object, hosts?: string[], replace?: boolean, dryRun?: boolean, now?: Date }} opts
 *   hosts: the ids to publish to (default: every ledger host); naming a host that isn't
 *   in the ledger reports it as not installed, except "agents", which is opt-in.
 */
export async function publishToHosts(name, { home = homeDir(), env = process.env, hosts, replace = false, dryRun = false, now = new Date() } = {}) {
  if (!isSkillName(name)) throw new Error(`not a valid skill name: ${name}`);
  const cur = libraryCurrent(name, { env });
  if (!cur) return [];
  const root = adRoot({ env, homedir: () => home });
  const ledger = readLedger(root);
  // Opt-in folders the user published to before are kept up to date too (accept, undo).
  const ids = hosts ?? [...Object.keys(ledger.hosts), ...(cur.meta.publishedTo ?? []).filter((id) => SKILL_TARGETS[id]?.optIn)];
  const results = [];
  let changed = false;
  let optedIn = false;
  for (const id of ids) {
    const t = SKILL_TARGETS[id];
    if (!t || id === "claude-code") continue; // Claude Code: the library writes ad init's lane itself
    if (!t.own) {
      // Cursor also reads Codex's folder (S-HOSTCFG): with both installed it may see two copies.
      const twice = id === "cursor" && ledger.hosts.codex;
      results.push({ id, label: t.label, status: "via", text: twice ? PUBLISH_TEXTS.viaTwice(t.label) : PUBLISH_TEXTS.via(t.label) });
      continue;
    }
    if (!t.optIn && !ledger.hosts[id]) {
      results.push({ id, label: t.label, status: "not-installed", text: PUBLISH_TEXTS.notInstalled(t.label, id) });
      continue;
    }
    const dest = path.join(userSkillRoot(id, { home, env }), name);
    if (dryRun) {
      results.push({ id, label: t.label, status: "dry-run", path: dest });
      continue;
    }
    const exists = fs.existsSync(dest);
    let status = "written";
    if (exists && !ownedUnchanged(dest)) {
      if (!replace) {
        results.push({ id, label: t.label, status: "edited", path: dest, text: PUBLISH_TEXTS.edited(t.label, dest, name, id) });
        continue;
      }
      backupDir(root, id, dest, now);
      status = "replaced";
    }
    const marker = { name, version: cur.meta.version, sha256: cur.sha256, publishedAt: now.toISOString() };
    await writeSkillDir(dest, { fromDir: cur.dir, extra: { [MARKER]: JSON.stringify(marker, null, 2) + "\n" } });
    if (ledger.hosts[id]) {
      ledger.hosts[id].skills = { ...(ledger.hosts[id].skills ?? {}), [name]: { version: cur.meta.version, sha256: cur.sha256, path: dest } };
      changed = true;
    }
    if (t.optIn && !(cur.meta.publishedTo ?? []).includes(id)) {
      cur.meta.publishedTo = [...(cur.meta.publishedTo ?? []), id];
      optedIn = true;
    }
    results.push({ id, label: t.label, status, path: dest });
  }
  if (changed) await writeLedger(root, ledger);
  if (optedIn) await writeJsonAtomic(path.join(libraryRoot({ env }), name, "meta.json"), cur.meta);
  return results;
}

/** For uninstall: remove the skill folders ad published for a host, if unchanged. → lines to print */
export function removePublishedSkills(rec) {
  const lines = [];
  for (const [name, s] of Object.entries(rec?.skills ?? {})) {
    if (!isSkillName(name) || !s?.path || path.basename(s.path) !== name) continue;
    if (!fs.existsSync(s.path)) continue;
    if (ownedUnchanged(s.path)) {
      fs.rmSync(s.path, { recursive: true, force: true, maxRetries: 3 });
      lines.push(`removed the skill ${name} (${s.path})`);
    } else lines.push(`kept the skill ${name} (${s.path}): it was changed outside ad`);
  }
  return lines;
}

/** Every skill with a library entry. */
export function librarySkills({ env = process.env } = {}) {
  try {
    return fs.readdirSync(libraryRoot({ env })).filter((n) => isSkillName(n) && libraryCurrent(n, { env })).sort();
  } catch {
    return [];
  }
}

/**
 * `--remove`: stop publishing a skill to one host (the opt-in ~/.agents/skills, say):
 * ad's copy goes when nobody changed it, and accepts and undos no longer write there.
 */
async function unpublish(name, id, { home, env, out }) {
  const cur = libraryCurrent(name, { env });
  const dest = path.join(userSkillRoot(id, { home, env }) ?? "", name);
  const root = adRoot({ env, homedir: () => home });
  if (cur?.meta.publishedTo?.includes(id)) {
    cur.meta.publishedTo = cur.meta.publishedTo.filter((x) => x !== id);
    await writeJsonAtomic(path.join(libraryRoot({ env }), name, "meta.json"), cur.meta);
  }
  const ledger = readLedger(root);
  if (ledger.hosts[id]?.skills?.[name]) {
    delete ledger.hosts[id].skills[name];
    await writeLedger(root, ledger);
  }
  if (!fs.existsSync(dest)) out(`  · ${name}: nothing of ad's in ${SKILL_TARGETS[id].label}`);
  else if (ownedUnchanged(dest)) {
    fs.rmSync(dest, { recursive: true, force: true, maxRetries: 3 });
    out(`  ✓ ${name}: removed from ${SKILL_TARGETS[id].label} (${dest})`);
  } else out(`  · ${name}: kept ${dest}: it was changed outside ad`);
  return 0;
}

/** `ad skill publish [<name>] [--host <id>] [--replace] [--dry-run] [--remove]`. */
export async function publishCommand({ name, host, replace = false, dryRun = false, remove = false, out = console.log, err = console.error, home = homeDir(), env = process.env }) {
  if (host && !SKILL_TARGETS[host]) {
    err(`ad skill publish: unknown host "${host}" (${Object.keys(SKILL_TARGETS).join(", ")})`);
    return 1;
  }
  if (name !== undefined && !isSkillName(name)) {
    err(`ad skill publish: "${name}" isn't a skill name (kebab-case)`);
    return 1;
  }
  if (remove) {
    // Only an opt-in folder: an installed host gets every accepted skill again on the next
    // accept (uninstall ad's memory there to stop it).
    if (!name || !host || !SKILL_TARGETS[host].optIn) {
      err("ad skill publish --remove: name a skill and an opt-in folder (--host agents). For an installed host, uninstall ad's memory there: npx agent-daemon-memory uninstall --host <id>");
      return 1;
    }
    return unpublish(name, host, { home, env, out });
  }
  const names = name ? [name] : librarySkills({ env });
  if (name && !libraryCurrent(name, { env })) {
    err(`ad skill publish: ${name} has no accepted version (accept a proposal in ad review first)`);
    return 1;
  }
  if (!names.length) {
    out("No accepted skills to publish yet.");
    return 0;
  }
  if (host === "agents") out(`  ⚠ ${PUBLISH_TEXTS.duplicate}`);
  let fails = 0;
  for (const n of names) {
    const rows = await publishToHosts(n, { home, env, hosts: host ? [host] : undefined, replace, dryRun });
    if (!rows.length) out(`${n}: no hosts to publish to beyond Claude Code.`);
    for (const r of rows) {
      if (r.status === "written" || r.status === "replaced") out(`  ✓ ${n} → ${r.label}: ${r.path}${r.status === "replaced" ? " (the old folder was backed up)" : ""}`);
      else if (r.status === "dry-run") out(`  · ${n} → ${r.label}: would write ${r.path}`);
      else if (r.status === "edited") {
        out(`  ✗ ${r.text}`);
        fails++;
      } else out(`  · ${r.text}`);
    }
  }
  return fails ? 1 : 0;
}
