// P5.7b: accepted skills reach every host ad's memory is installed in. Codex and
// Gemini get their own folder with ad's marker; hosts that read Claude Code's folder
// get nothing more; a folder changed outside ad is never overwritten without
// --replace (backed up first); uninstall removes only unchanged folders of ours; the
// public host packages never carry the user's library.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = await fs.mkdtemp(path.join(os.tmpdir(), "ad-skill-pub-"));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.AD_ROOT = path.join(HOME, ".agent-daemon");
for (const k of ["AD_MEMORY_DB", "AD_MEMORY_PROJECT", "CLAUDE_PROJECT_DIR", "AD_TOOL_SHELL", "CLAUDE_CONFIG_DIR", "CODEX_HOME"]) delete process.env[k];

const { renderSkillProposal, skillSha } = await import("../src/skills/proposal.mjs");
const lib = await import("../src/skills/library.mjs");
const pub = await import("../src/skills/publish.mjs");
const { writeLedger, readLedger } = await import("../src/memory-install/ledger.mjs");
const ep = await import("../src/memory/episodic.mjs");

before(async () => {
  await ep.db();
});
after(async () => {
  ep.closeDb();
  await fs.rm(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const ROOT = path.join(HOME, ".agent-daemon");
const skill = (name, d) => `---\nname: ${name}\ndescription: Use when testing publishing (${d}).\n---\n\n# ${name}\n\nSteps.\n`;
const read = (p) => readFileSync(p, "utf8");
const codexRoot = path.join(HOME, ".codex", "skills");
const geminiRoot = path.join(HOME, ".gemini", "skills");
const ledgerWith = (...ids) => writeLedger(ROOT, { schemaVersion: 1, hosts: Object.fromEntries(ids.map((id) => [id, { driver: "file", file: path.join(HOME, `${id}.json`), version: "3.0.0", installedBy: "npx" }])) });

let n = 0;
async function accepted(d = "B") {
  const name = `pub-skill-${++n}`;
  const installed = path.join(HOME, ".claude", "skills", name);
  await fs.mkdir(installed, { recursive: true });
  await fs.writeFile(path.join(installed, "SKILL.md"), skill(name, "A"));
  const cwd = path.join(HOME, "work", `p${n}`);
  await fs.mkdir(path.join(cwd, ".agent-daemon", "proposed"), { recursive: true });
  const file = path.join(cwd, ".agent-daemon", "proposed", `skill-${name}.md`);
  await fs.writeFile(file, renderSkillProposal({ skill: name, base: skillSha(skill(name, "A")), body: skill(name, d), origin: "gepa", host: "claude-code" }));
  const r = await lib.applySkillProposal(file, { cwd, bundled: new Map() });
  return { name, installed, cwd, r };
}

test("accept publishes to the ledger's hosts: their own folder plus ad's marker; Cursor and OpenCode read Claude Code's", async () => {
  await ledgerWith("claude-code", "codex", "gemini", "cursor", "opencode");
  const s = await accepted();
  assert.equal(s.r.ok, true, s.r.text);
  assert.match(s.r.text, /published to: Claude Code, ad, Codex, Gemini CLI\./);
  for (const root of [codexRoot, geminiRoot]) {
    assert.equal(read(path.join(root, s.name, "SKILL.md")), skill(s.name, "B"));
    const marker = JSON.parse(read(path.join(root, s.name, ".ad-skill.json")));
    assert.deepEqual([marker.name, marker.version, marker.sha256], [s.name, 2, skillSha(skill(s.name, "B"))]);
  }
  assert.ok(!existsSync(path.join(HOME, ".cursor", "skills", s.name)), "Cursor reads ~/.claude/skills: no second copy");
  assert.ok(!existsSync(path.join(HOME, ".agents", "skills", s.name)), "~/.agents/skills only when named");
  const ledger = readLedger(ROOT);
  assert.deepEqual(ledger.hosts.codex.skills[s.name], { version: 2, sha256: skillSha(skill(s.name, "B")), path: path.join(codexRoot, s.name) });
  // CODEX_HOME moves Codex's folder.
  assert.equal((await import("../src/hosts/skill-formats.mjs")).userSkillRoot("codex", { home: HOME, env: { CODEX_HOME: path.join(HOME, "ch") } }), path.join(HOME, "ch", "skills"));
});

test("a host folder changed outside ad is skipped, bytes untouched; --replace backs it up, then replaces", async () => {
  await ledgerWith("claude-code", "codex");
  const s = await accepted();
  const mine = path.join(codexRoot, s.name, "SKILL.md");
  await fs.writeFile(mine, skill(s.name, "edited by hand"));
  const lines = [];
  const out = (l) => lines.push(l);
  assert.equal(await pub.publishCommand({ name: s.name, out, err: out }), 1);
  assert.match(lines.join("\n"), new RegExp(`✗ Codex: .* was changed outside ad, so it wasn't overwritten\\. Keep it, or run: ad skill publish ${s.name} --host codex --replace`));
  assert.match(read(mine), /edited by hand/);
  // A folder ad never wrote (no marker) is the user's too.
  const other = path.join(codexRoot, "users-own");
  await fs.mkdir(other, { recursive: true });
  await fs.writeFile(path.join(other, "SKILL.md"), "mine\n");
  assert.equal(pub.ownedUnchanged(other), false);
  assert.equal(await pub.publishCommand({ name: s.name, host: "codex", replace: true, out, err: out }), 0);
  assert.equal(read(mine), skill(s.name, "B"));
  const backups = readdirSync(path.join(ROOT, "memory", "backups", "codex"));
  assert.equal(backups.length, 1);
  assert.match(read(path.join(ROOT, "memory", "backups", "codex", backups[0], "SKILL.md")), /edited by hand/);
});

test("hosts outside the ledger are skipped with the install hint; --dry-run writes nothing; agents only when named", async () => {
  await ledgerWith("claude-code", "codex");
  const s = await accepted();
  const lines = [];
  const out = (l) => lines.push(l);
  await pub.publishCommand({ name: s.name, host: "gemini", out, err: out });
  assert.match(lines.join("\n"), /Gemini CLI: ad's memory isn't installed there \(ad memory install --host gemini\)/);
  assert.ok(!existsSync(path.join(geminiRoot, s.name)));
  await pub.publishCommand({ name: s.name, host: "agents", dryRun: true, out, err: out });
  assert.match(lines.join("\n"), /would write .*\.agents[\\/]skills/);
  assert.match(lines.join("\n"), /may list the skill twice/);
  assert.ok(!existsSync(path.join(HOME, ".agents", "skills", s.name)));
  assert.equal(await pub.publishCommand({ name: "never-accepted", out, err: out }), 1);
  assert.equal(await pub.publishCommand({ name: "../x", out, err: out }), 1);
  assert.equal(await pub.publishCommand({ name: s.name, host: "codex", remove: true, out, err: out }), 1, "--remove is for opt-in folders only");
});

test("an opt-in folder stays current: published once with --host agents, refreshed by undo; Cursor beside Codex is warned", async () => {
  await ledgerWith("claude-code", "codex", "cursor");
  const s = await accepted();
  const lines = [];
  const out = (l) => lines.push(l);
  assert.equal(await pub.publishCommand({ name: s.name, host: "agents", out, err: out }), 0);
  const agents = path.join(HOME, ".agents", "skills", s.name, "SKILL.md");
  assert.equal(read(agents), skill(s.name, "B"));
  const u = await lib.undoSkill(s.name, { cwd: s.cwd, bundled: new Map() });
  assert.equal(u.ok, true, u.text);
  assert.equal(read(agents), skill(s.name, "A"), "the opt-in copy follows the undo");
  const rows = await pub.publishToHosts(s.name, {});
  assert.equal(rows.find((r) => r.id === "cursor").text, "Cursor: reads Claude Code's skills folder and Codex's, so it may list the skill twice");
  // --remove stops it: ad's copy goes, and the next undo doesn't write it back.
  assert.equal(await pub.publishCommand({ name: s.name, host: "agents", remove: true, out, err: out }), 0);
  assert.ok(!existsSync(agents));
  await lib.undoSkill(s.name, { cwd: s.cwd, bundled: new Map() });
  assert.ok(!existsSync(agents), "no longer published there");
});

test("uninstall removes only unchanged skill folders of ours", async () => {
  await ledgerWith("claude-code", "codex", "gemini");
  const s = await accepted();
  await fs.writeFile(path.join(geminiRoot, s.name, "SKILL.md"), skill(s.name, "edited"));
  const ledger = readLedger(ROOT);
  assert.deepEqual(pub.removePublishedSkills(ledger.hosts.codex), [`removed the skill ${s.name} (${path.join(codexRoot, s.name)})`]);
  assert.ok(!existsSync(path.join(codexRoot, s.name)));
  assert.match(pub.removePublishedSkills(ledger.hosts.gemini)[0], /kept the skill .*: it was changed outside ad/);
  assert.ok(existsSync(path.join(geminiRoot, s.name, "SKILL.md")));
  // A forged ledger path outside a skill folder of that name is ignored.
  assert.deepEqual(pub.removePublishedSkills({ skills: { [s.name]: { path: HOME } } }), []);
  assert.ok(existsSync(HOME));
});

test("the public host packages never carry the user's skill library", async () => {
  const s = await accepted("PRIVATE-MARKER-xyz");
  const { build } = await import("../scripts/build-host-packages.mjs");
  const out = path.join(HOME, "build");
  build({ out, targets: ["claude-code", "agent-plugin", "cursor", "gemini"] });
  const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const f of walk(out)) {
    assert.doesNotMatch(read(f), /PRIVATE-MARKER-xyz/, f);
    assert.ok(!f.includes(s.name), f);
  }
});
