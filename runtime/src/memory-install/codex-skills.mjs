// Codex's command skills (MCP launch plan L3, Decision 20): setup writes
// $CODEX_HOME/skills/<package>-remember|recall|report (SKILL.md, agents/openai.yaml)
// with ad's publish marker (.ad-skill.json: name, version, sha256 of the folder),
// and records each folder as a ledger v2 `skill-dir` item. Uninstall removes a folder
// only when it still carries the marker and nobody changed it (ledger2 removalDecision);
// a folder of that name that isn't ad's, or that the user edited, is never overwritten.
// Codex also reads ~/.agents/skills: doctor flags a name in both (listed twice).

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { COMMANDS, codexSkillName, invocation, renderCommandSkill } from "./command-skills.mjs";
import { codexHome } from "./setup-codex.mjs";
import { openLedger2ForWrite, removalDecision, upsertItem, writeLedger2 } from "./ledger2.mjs";
import { launcherFile } from "../memory/launch/dists.mjs";

export const SKILL_MARKER = ".ad-skill.json";

export const codexSkillsRoot = (ctx) => path.join(codexHome(ctx), "skills");
const agentsSkillsRoot = (ctx) => path.join(ctx.home, ".agents", "skills");

const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
// One hash for a folder's files (the marker aside): each relative path and its bytes' hash.
const filesSha = (files) =>
  sha(
    files
      .map((f) => [f.path, sha(Buffer.isBuffer(f.bytes) ? f.bytes : Buffer.from(f.text, "utf8"))])
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([p, h]) => `${p}\n${h}\n`)
      .join(""),
  );

/** The folder's files as they are now (the marker left out). */
function readFolder(dir) {
  const out = [];
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (!rel && e.name === SKILL_MARKER) continue;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else out.push({ path: r, bytes: fs.readFileSync(path.join(d, e.name)) });
    }
  };
  walk(dir, "");
  return out;
}

function readMarker(dir) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, SKILL_MARKER), "utf8"));
    return m && typeof m === "object" ? m : null;
  } catch {
    return null;
  }
}

/** A skill folder as uninstall weighs it: { sha256, marker } (marker: ad's, for this name). */
export function liveSkill(dir, name) {
  if (!fs.existsSync(dir)) return undefined;
  const m = readMarker(dir);
  return { sha256: filesSha(readFolder(dir)), marker: m?.name === name };
}

/**
 * What setup does with each command skill → [{ name, dir, action, why?, files?, item? }]
 * action: add | update (ad's folder, an older version) | same | keep (not ad's, or changed)
 */
export function planCodexSkills(ctx) {
  const root = codexSkillsRoot(ctx);
  const launcher = launcherFile(ctx.root);
  return COMMANDS.map((command) => {
    const name = codexSkillName(command);
    const dir = path.join(root, name);
    const files = renderCommandSkill("codex", command, { version: ctx.version, launcher, command: ctx.command });
    const item = { kind: "skill-dir", file: dir, locator: { name }, value: { sha256: filesSha(files) }, preExisted: false };
    if (!fs.existsSync(dir)) return { command, name, dir, action: "add", files, item };
    const marker = readMarker(dir);
    const live = filesSha(readFolder(dir));
    // ad wrote it (its marker, this name) and nobody changed it since.
    if (marker?.name !== name) return { command, name, dir, action: "keep", why: "a skill of that name that isn't ad's; left as it is" };
    if (marker.sha256 !== live) return { command, name, dir, action: "keep", why: "you changed it, so it was left as it is" };
    if (live === item.value.sha256) return { command, name, dir, action: "same", item };
    return { command, name, dir, action: "update", files, item };
  });
}

/** For install's "finish in a terminal": the skills setup would add or update. */
export function pendingCodexSkills(ctx) {
  try {
    return planCodexSkills(ctx)
      .filter((p) => p.action === "add" || p.action === "update")
      .map((p) => ({ kind: "skill-dir", action: p.action, file: p.dir }));
  } catch (e) {
    return [{ error: e.message }];
  }
}

function writeFolder(dir, files, { name, version, now }) {
  // An update replaces ad's folder whole (planCodexSkills checked it is ad's and unchanged),
  // so a file a newer version dropped doesn't linger and read as the user's change.
  fs.rmSync(dir, { recursive: true, force: true });
  for (const f of files) {
    const dest = path.join(dir, ...f.path.split("/"));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, f.text);
  }
  fs.writeFileSync(path.join(dir, SKILL_MARKER), JSON.stringify({ name, version, sha256: filesSha(files), publishedAt: now.toISOString() }, null, 2) + "\n");
}

/**
 * setup's Codex skills step (run under the ledger lock). → { code, changed }
 * code 2 when a folder couldn't be written; a folder kept as the user's is reported, not an error.
 */
export async function setupCodexSkills(ctx, { dryRun = false, now = new Date() } = {}) {
  const { out } = ctx;
  const plan = planCodexSkills(ctx);
  const label = (p) => `the skill ${invocation("codex", p.command)}`;
  for (const p of plan.filter((x) => x.action === "keep")) out(`· Codex: ${label(p)}: ${ctx.display(p.dir)} is ${p.why}. To use ad's, remove that folder and run ${ctx.command("setup --host codex")} again`);
  if (dryRun) {
    for (const p of plan.filter((x) => x.action === "add" || x.action === "update")) out(`  would ${p.action} ${label(p)} in ${ctx.display(p.dir)}`);
    return { code: 0, changed: false };
  }
  const done = [];
  let failed = false;
  for (const p of plan) {
    if (p.action !== "add" && p.action !== "update") {
      if (p.action === "same") done.push(p);
      continue;
    }
    try {
      writeFolder(p.dir, p.files, { name: p.name, version: ctx.version, now });
      done.push(p);
      out(`✓ Codex: ${label(p)} ${p.action === "add" ? "added" : "updated"} in ${ctx.display(p.dir)}`);
    } catch (e) {
      failed = true;
      out(`✗ Codex: ${label(p)}: couldn't write ${ctx.display(p.dir)}: ${e.message}`);
    }
  }
  const opened = openLedger2ForWrite(ctx.root);
  if (opened.refuse) {
    out(`✗ ${opened.refuse}`);
    return { code: 2, changed: done.some((p) => p.action !== "same") };
  }
  for (const p of done) upsertItem(opened.ledger, { host: "codex", ...p.item, version: ctx.version, now });
  await writeLedger2(ctx.root, opened.ledger);
  return { code: failed ? 2 : 0, changed: done.some((p) => p.action !== "same") };
}

/**
 * Uninstall: each recorded skill folder, removed when it is ad's and unchanged.
 * → [{ item, action: "removed"|"kept"|"gone", why?, how? }] (uninstall's directResults shape)
 */
export function removeCodexSkills(ctx, items) {
  const roots = [codexSkillsRoot(ctx)];
  return items.map((item) => {
    const live = liveSkill(item.file, item.locator?.name);
    const d = removalDecision(item, live, { skillRoots: roots });
    if (d.action === "gone") return { item, action: "gone" };
    if (d.action === "keep") return { item, action: "kept", why: d.why, how: `delete the folder ${ctx.display(item.file)}` };
    try {
      fs.rmSync(item.file, { recursive: true, force: true, maxRetries: 3 });
      return { item, action: "removed" };
    } catch (e) {
      return { item, action: "kept", why: `${ctx.display(item.file)}: ${e.message}; run uninstall again`, retry: true };
    }
  });
}

/** Our skill names Codex finds twice (its own folder and ~/.agents/skills). */
export function duplicateCodexSkills(ctx) {
  return COMMANDS.map(codexSkillName).filter((n) => fs.existsSync(path.join(codexSkillsRoot(ctx), n, "SKILL.md")) && fs.existsSync(path.join(agentsSkillsRoot(ctx), n, "SKILL.md")));
}

