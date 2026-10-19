// P5.7a: accepting a skill proposal applies it. The skill library keeps every version
// (~/.agent-daemon/skills/<name>/), the copy hosts load gets the new SKILL.md, undo makes
// an older version current as a new version, and ad init keeps an accepted version.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { existsSync, readFileSync, readdirSync, utimesSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = await fs.mkdtemp(path.join(os.tmpdir(), "ad-skill-lib-"));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.AD_ROOT = path.join(HOME, ".agent-daemon");
for (const k of ["AD_MEMORY_DB", "AD_MEMORY_PROJECT", "CLAUDE_PROJECT_DIR", "AD_TOOL_SHELL", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "AD_ENGINE_HOME"]) delete process.env[k];

const { renderSkillProposal, skillSha } = await import("../src/skills/proposal.mjs");
const lib = await import("../src/skills/library.mjs");
const { installSkillLane } = await import("../src/skill-install.mjs");
const ep = await import("../src/memory/episodic.mjs");

let handle;
before(async () => {
  handle = await ep.db();
});
after(async () => {
  ep.closeDb();
  await fs.rm(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const skill = (name, description, extra = "") => `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nSteps.\n${extra}`;
const A = (name) => skill(name, "Use when testing the skill library (version A).");
const B = (name) => skill(name, "Use when testing the skill library (version B).");

let n = 0;
/** A fresh skill: bundled source + installed global copy (A), a project, a v1 proposal (B). */
async function setup({ body = B, base } = {}) {
  const name = `demo-skill-${++n}`;
  const bundledDir = path.join(HOME, "bundled", name);
  await fs.mkdir(bundledDir, { recursive: true });
  await fs.writeFile(path.join(bundledDir, "SKILL.md"), A(name));
  await fs.writeFile(path.join(bundledDir, "helper.txt"), "kept\n");
  const installed = path.join(HOME, ".claude", "skills", name);
  await fs.cp(bundledDir, installed, { recursive: true });
  const cwd = path.join(HOME, "work", `p${n}`);
  await fs.mkdir(path.join(cwd, ".agent-daemon", "proposed"), { recursive: true });
  await fs.mkdir(path.join(cwd, ".git"), { recursive: true });
  const file = path.join(cwd, ".agent-daemon", "proposed", `skill-${name}-1.md`);
  await fs.writeFile(file, renderSkillProposal({ skill: name, base: base ?? skillSha(A(name)), body: body(name), origin: "gepa", run: "r1", host: "claude-code" }));
  const bundled = new Map([[name, bundledDir]]);
  return { name, bundledDir, installed, cwd, file, bundled, opts: { cwd, home: HOME, bundled, handle } };
}
const read = (p) => readFileSync(p, "utf8");
const meta = (name) => JSON.parse(read(path.join(HOME, ".agent-daemon", "skills", name, "meta.json")));

test("accept → v1 (the base) and v2; the installed copy and current/ hold the proposed bytes; the file is filed", async () => {
  const s = await setup();
  const r = await lib.applySkillProposal(s.file, s.opts);
  assert.equal(r.ok, true, r.text);
  assert.equal(r.version, 2);
  assert.match(r.text, new RegExp(`✓ ${s.name} v2 accepted and published to: Claude Code, ad\\. Undo: ad skill undo ${s.name}`));
  const m = meta(s.name);
  assert.deepEqual(m.history.map((h) => [h.version, h.action]), [[1, "base"], [2, "accept"]]);
  assert.equal(m.version, 2);
  assert.equal(m.sha256, skillSha(B(s.name)));
  assert.equal(m.history[1].origin, "gepa");
  const libDir = path.join(HOME, ".agent-daemon", "skills", s.name);
  assert.equal(read(path.join(libDir, "current", "SKILL.md")), B(s.name));
  assert.equal(read(path.join(libDir, "versions", "1", "SKILL.md")), A(s.name));
  assert.equal(read(path.join(libDir, "versions", "2", "helper.txt")), "kept\n", "the rest of the skill folder travels with it");
  assert.equal(read(path.join(s.installed, "SKILL.md")), B(s.name));
  // Filed: applied/, with the outcome in its frontmatter; a proposals row.
  assert.ok(!existsSync(s.file));
  const filed = read(path.join(s.cwd, ".agent-daemon", "applied", path.basename(s.file)));
  assert.match(filed, /^resolved: accepted$/m);
  assert.match(filed, /^version: 2$/m);
  const row = handle.get("SELECT kind, status, resolved_at FROM proposals WHERE title = ?", [path.basename(s.file)]);
  assert.deepEqual([row.kind, row.status, Boolean(row.resolved_at)], ["skill-update", "accepted", true]);
});

test("the skill changed since the proposal: shown against today's file; nothing written unless confirmed", async () => {
  const s = await setup();
  await fs.writeFile(path.join(s.installed, "SKILL.md"), skill(s.name, "Use when testing drift (edited by hand)."));
  let shown = "";
  const r = await lib.applySkillProposal(s.file, { ...s.opts, confirmDrift: async (text) => ((shown = text), false) });
  assert.equal(r.ok, false);
  assert.match(shown, new RegExp(`${s.name} changed since this proposal was made\\. Showing the change against today's file\\.`));
  assert.match(shown, /-description: Use when testing drift \(edited by hand\)\./);
  assert.ok(existsSync(s.file), "still queued");
  assert.ok(!existsSync(path.join(HOME, ".agent-daemon", "skills", s.name)), "no library entry");
  assert.match(read(path.join(s.installed, "SKILL.md")), /edited by hand/);
  const ok = await lib.applySkillProposal(s.file, { ...s.opts, confirmDrift: async () => true });
  assert.equal(ok.ok, true, ok.text);
  assert.equal(meta(s.name).history[0].sha256, skillSha(skill(s.name, "Use when testing drift (edited by hand).")), "the base is today's file");
});

test("lint failure or a secret in the new SKILL.md → nothing written", async () => {
  const noTrigger = (name) => `---\nname: ${name}\ndescription: Short.\n---\n\nBody.\n`;
  const s1 = await setup({ body: (name) => noTrigger(name).replace("description: Short.\n", "") });
  const r1 = await lib.applySkillProposal(s1.file, s1.opts);
  assert.equal(r1.ok, false);
  assert.match(r1.text, /^Not applied: the new SKILL\.md fails lint: /);
  const key = ["sk", "test", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4"].join("-");
  const s2 = await setup({ body: (name) => B(name) + `\nUse ${key} for the demo.\n` });
  const r2 = await lib.applySkillProposal(s2.file, s2.opts);
  assert.equal(r2.ok, false);
  assert.equal(r2.text, "Not applied: the new SKILL.md looks like it contains a secret (openai-key).");
  for (const s of [s1, s2]) {
    assert.ok(existsSync(s.file));
    assert.equal(read(path.join(s.installed, "SKILL.md")), A(s.name));
    assert.ok(!existsSync(path.join(HOME, ".agent-daemon", "skills", s.name)));
  }
});

test("a damaged or forged proposal is refused before anything is read from disk", async () => {
  const s = await setup();
  await fs.writeFile(s.file, read(s.file).replace("version B", "version C"));
  const r = await lib.applySkillProposal(s.file, s.opts);
  assert.deepEqual([r.ok, r.text], [false, "This proposal file is damaged (its content doesn't match its checksum)."]);
  const s2 = await setup();
  await fs.writeFile(s2.file, "# just prose\n");
  const r2 = await lib.applySkillProposal(s2.file, s2.opts);
  assert.equal(r2.text, "This proposal is in an old format ad can't apply. Apply it by hand, then accept to file it.");
  const s3 = await setup();
  await fs.writeFile(s3.file, renderSkillProposal({ skill: "not-installed-anywhere", base: "a".repeat(64), body: B("not-installed-anywhere"), origin: "gepa" }));
  const r3 = await lib.applySkillProposal(s3.file, s3.opts);
  assert.equal(r3.text, "No skill named not-installed-anywhere is installed or bundled, so there is nothing to update.");
});

test("undo → v3 has v1's bytes; undoing the undo gives v4 = v2; the installed copy follows", async () => {
  const s = await setup();
  assert.equal((await lib.applySkillProposal(s.file, s.opts)).ok, true);
  const u1 = await lib.undoSkill(s.name, s.opts);
  assert.equal(u1.ok, true, u1.text);
  assert.match(u1.text, new RegExp(`${s.name} v3 \\(the content of v1\\) is current`));
  assert.equal(read(path.join(s.installed, "SKILL.md")), A(s.name));
  const u2 = await lib.undoSkill(s.name, s.opts);
  assert.equal(u2.version, 4);
  assert.equal(read(path.join(s.installed, "SKILL.md")), B(s.name));
  const m = meta(s.name);
  assert.deepEqual(m.history.map((h) => [h.version, h.action, h.from ?? null]), [[1, "base", null], [2, "accept", null], [3, "undo", 1], [4, "undo", 2]]);
  const to = await lib.undoSkill(s.name, { ...s.opts, to: 1 });
  assert.equal(to.version, 5);
  assert.equal(read(path.join(s.installed, "SKILL.md")), A(s.name));
  assert.equal((await lib.undoSkill(s.name, { ...s.opts, to: 9 })).text, `${s.name} has no version 9 (1–5).`);
  assert.equal((await lib.undoSkill("never-accepted", s.opts)).text, "never-accepted has no accepted versions to undo.");
  // History and diff read the library.
  assert.deepEqual((await lib.skillHistory(s.name)).map((h) => h.version), [1, 2, 3, 4, 5]);
  assert.match(await lib.skillDiff(s.name, { from: 1, to: 2 }), /-description: Use when testing the skill library \(version A\)\.\n\+description: Use when testing the skill library \(version B\)\./);
});

test("ad init after an accept keeps the library version, and says so when the bundled skill moved on", async () => {
  const s = await setup();
  assert.equal((await lib.applySkillProposal(s.file, s.opts)).ok, true);
  // The bundled copy is newer on disk (an upgrade touched it) but unchanged in content.
  const future = new Date(Date.now() + 60_000);
  utimesSync(path.join(s.bundledDir, "SKILL.md"), future, future);
  const notices = [];
  const lane = path.join(HOME, ".claude", "skills");
  let r = await installSkillLane([s.name], s.bundled, lane, { notice: (t) => notices.push(t) });
  assert.equal(read(path.join(s.installed, "SKILL.md")), B(s.name), "the accepted version stays");
  assert.deepEqual(notices, []);
  assert.equal(r.updated, 0);
  // The bundled skill changed since the base: kept, with the notice.
  await fs.writeFile(path.join(s.bundledDir, "SKILL.md"), skill(s.name, "Use when testing a newer bundled release."));
  utimesSync(path.join(s.bundledDir, "SKILL.md"), future, future);
  r = await installSkillLane([s.name], s.bundled, lane, { notice: (t) => notices.push(t) });
  assert.equal(read(path.join(s.installed, "SKILL.md")), B(s.name));
  assert.deepEqual(notices, [`Kept your accepted version of ${s.name}; this ad release ships a newer one. Compare: ad skill diff ${s.name} --bundled`]);
  // A lane that lost the skill gets the library version back.
  await fs.rm(s.installed, { recursive: true });
  await installSkillLane([s.name], s.bundled, lane, { notice: () => {} });
  assert.equal(read(path.join(s.installed, "SKILL.md")), B(s.name));
  // A skill with no library entry: today's mtime rule.
  const plain = await setup();
  utimesSync(path.join(plain.bundledDir, "SKILL.md"), future, future);
  await fs.writeFile(path.join(plain.bundledDir, "SKILL.md"), skill(plain.name, "Use when testing the plain upgrade path."));
  utimesSync(path.join(plain.bundledDir, "SKILL.md"), future, future);
  r = await installSkillLane([plain.name], plain.bundled, lane, { notice: () => {} });
  assert.equal(r.updated, 1);
  assert.match(read(path.join(plain.installed, "SKILL.md")), /plain upgrade path/);
});

test("skill-lesson: the lesson joins the skill under ## Learned from use", async () => {
  const s = await setup();
  await fs.writeFile(s.file, renderSkillProposal({ kind: "skill-lesson", skill: s.name, body: "Run the linter before committing.", origin: "digest", run: "s1" }));
  const r = await lib.applySkillProposal(s.file, { ...s.opts, now: new Date("2026-10-19T10:00:00Z") });
  assert.equal(r.ok, true, r.text);
  const text = read(path.join(s.installed, "SKILL.md"));
  assert.ok(text.startsWith(A(s.name)));
  assert.match(text, /\n## Learned from use\n\n- Run the linter before committing\. \(2026-10-19, ad review\)\n$/);
  // A lesson with no skill named: the caller must say which.
  await fs.writeFile(s.file, renderSkillProposal({ kind: "skill-lesson", body: "Prefer pnpm.", origin: "digest" }));
  const q = await lib.applySkillProposal(s.file, s.opts);
  assert.deepEqual([q.ok, q.needsSkill], [false, true]);
  const named = await lib.applySkillProposal(s.file, { ...s.opts, lessonSkill: s.name });
  assert.equal(named.ok, true, named.text);
  assert.match(read(path.join(s.installed, "SKILL.md")), /- Prefer pnpm\. \(/);
});

test("legacy proposals: ad evolve's body-only file takes today's frontmatter, after a second confirmation", async () => {
  const s = await setup();
  const evolve = [`# Proposed skill update — ${s.name}`, "", "Scores…", "", "## Winner body", "", "```markdown", `# ${s.name}`, "", "Better steps.", "```", ""].join("\n");
  await fs.writeFile(s.file, evolve);
  const no = await lib.applySkillProposal(s.file, { ...s.opts, confirmLegacy: async () => false });
  assert.equal(no.ok, false);
  assert.equal(read(path.join(s.installed, "SKILL.md")), A(s.name));
  const yes = await lib.applySkillProposal(s.file, { ...s.opts, confirmLegacy: async () => true });
  assert.equal(yes.ok, true, yes.text);
  assert.equal(read(path.join(s.installed, "SKILL.md")), `---\nname: ${s.name}\ndescription: Use when testing the skill library (version A).\n---\n\n# ${s.name}\n\nBetter steps.\n`);
});

test("the review diff shows escape codes and invisible characters instead of their effect", async () => {
  const esc = String.fromCharCode(27);
  const rlo = String.fromCodePoint(0x202e);
  const s = await setup({ body: (name) => B(name) + `\nHidden ${esc}[2K line and ${rlo}reversed.\n` });
  const p = await lib.previewSkillProposal(s.file, s.opts);
  assert.equal(p.ok, true, p.text);
  assert.doesNotMatch(p.diff, new RegExp(esc));
  assert.ok(!p.diff.includes(rlo));
  assert.match(p.diff, /\+Hidden <U\+001B>\[2K line and <U\+202E>reversed\./);
});

test("refused: hidden characters added, a renamed skill; frontmatter that widens a skill is called out", async () => {
  const tag = String.fromCodePoint(0xe0041);
  const s1 = await setup({ body: (name) => B(name) + `\nRun the tests.${tag}${String.fromCodePoint(0xe0042)}\n` });
  const p1 = await lib.previewSkillProposal(s1.file, s1.opts);
  assert.match(p1.diff, /<U\+E0041><U\+E0042>/, "shown, not hidden");
  const r1 = await lib.applySkillProposal(s1.file, s1.opts);
  assert.equal(r1.text, "Not applied: the new SKILL.md adds characters a terminal doesn't show (U+E0041, U+E0042), so the change can't be reviewed.");
  const s2 = await setup({ body: (name) => B(name).replace(`name: ${name}`, "name: debug-triage") });
  const r2 = await lib.applySkillProposal(s2.file, s2.opts);
  assert.match(r2.text, /^Not applied: the new SKILL\.md fails lint: name "debug-triage" must stay/);
  const s3 = await setup({ body: (name) => B(name).replace("---\n\n#", "allowed-tools: Bash\n---\n\n#") });
  const p3 = await lib.previewSkillProposal(s3.file, s3.opts);
  assert.deepEqual(p3.warnings, [`This change edits the skill's allowed-tools: "(none)" → "Bash"`]);
  // A YAML block value: one more list item is a change too.
  const listed = (name, items) => B(name).replace("---\n\n#", `allowed-tools:\n${items.map((i) => `  - ${i}`).join("\n")}\n---\n\n#`);
  const s4 = await setup({ body: (name) => listed(name, ["Read", "Bash(*)"]) });
  await fs.writeFile(path.join(s4.installed, "SKILL.md"), listed(s4.name, ["Read"]).replace("version B", "version A"));
  const p4 = await lib.previewSkillProposal(s4.file, { ...s4.opts });
  assert.deepEqual(p4.warnings, [`This change edits the skill's allowed-tools: "- Read" → "- Read - Bash(*)"`]);
  // A repeated key (YAML keeps the last) is refused.
  const s6 = await setup({ body: (name) => B(name).replace("---\n\n#", "allowed-tools: Read\nallowed-tools: Bash(*)\n---\n\n#") });
  assert.match((await lib.applySkillProposal(s6.file, s6.opts)).text, /fails lint: the frontmatter repeats `allowed-tools`/);
  // More of a hidden character than the skill already had is refused as well.
  const s5 = await setup({ body: (name) => B(name) + `\nOne ${tag}${tag}\n` });
  await fs.writeFile(path.join(s5.installed, "SKILL.md"), A(s5.name) + `\nOne ${tag}\n`);
  assert.match((await lib.applySkillProposal(s5.file, { ...s5.opts, confirmDrift: async () => true })).text, /adds characters a terminal doesn't show \(U\+E0041\)/);
  for (const s of [s1, s2]) assert.equal(read(path.join(s.installed, "SKILL.md")), A(s.name));
});

test("what was shown is what is applied: a proposal changed after it was shown is refused", async () => {
  const s = await setup();
  const shown = await lib.previewSkillProposal(s.file, s.opts);
  await fs.writeFile(s.file, renderSkillProposal({ skill: s.name, base: skillSha(A(s.name)), body: skill(s.name, "Use when testing a swapped proposal."), origin: "gepa" }));
  const r = await lib.applySkillProposal(s.file, { ...s.opts, expect: shown.expect });
  assert.equal(r.text, "The proposal or the skill changed while you were reading it, so nothing was applied. Run ad review again to see the change as it is now.");
  assert.equal(read(path.join(s.installed, "SKILL.md")), A(s.name));
});

test("undo keeps hand edits in a backup; a failed host write still files the proposal", async () => {
  const s = await setup();
  assert.equal((await lib.applySkillProposal(s.file, s.opts)).ok, true);
  await fs.writeFile(path.join(s.installed, "SKILL.md"), skill(s.name, "Use when testing hand edits after an accept."));
  const u = await lib.undoSkill(s.name, s.opts);
  assert.match(u.text, /your edits to .* were backed up to /);
  const backups = path.join(HOME, ".agent-daemon", "memory", "backups", "claude-code");
  assert.ok(readdirSync(backups).some((d) => read(path.join(backups, d, "SKILL.md")).includes("hand edits")));
  // Staging sits beside the skills root, never in it; a stale entry is swept on the next
  // write; skills are never touched.
  const root = path.join(HOME, ".claude", "skills");
  const stale = path.join(HOME, ".claude", ".ad-skill-staging", "x-tmp-stale");
  await fs.mkdir(stale, { recursive: true });
  const oldTime = new Date(Date.now() - 2 * 3_600_000);
  utimesSync(stale, oldTime, oldTime);
  const neighbour = path.join(root, "old-neighbour");
  await fs.mkdir(neighbour, { recursive: true });
  await fs.writeFile(path.join(neighbour, "SKILL.md"), "x\n");
  utimesSync(neighbour, oldTime, oldTime);
  await lib.undoSkill(s.name, s.opts);
  assert.ok(!existsSync(stale), "the stale staging entry is swept");
  assert.ok(existsSync(path.join(neighbour, "SKILL.md")), "a skill beside it is never swept");
  assert.ok(!readdirSync(root).some((d) => /-(tmp|old)-|staging/.test(d)), "no staging folder among the skills");
  // A host folder ad can't write (here: a file where Codex's skills folder goes).
  const { writeLedger } = await import("../src/memory-install/ledger.mjs");
  await writeLedger(path.join(HOME, ".agent-daemon"), { schemaVersion: 1, hosts: { codex: { driver: "file" } } });
  await fs.mkdir(path.join(HOME, ".codex"), { recursive: true });
  await fs.writeFile(path.join(HOME, ".codex", "skills"), "not a folder");
  const s2 = await setup();
  const r = await lib.applySkillProposal(s2.file, s2.opts);
  assert.equal(r.ok, true);
  assert.match(r.text, new RegExp(`✓ ${s2.name} v2 accepted, but writing it to the hosts failed \\(\\w+\\)\\. Run ad init`));
  assert.ok(!existsSync(s2.file), "filed, so accepting again can't make a second version");
  await fs.rm(path.join(HOME, ".codex"), { recursive: true });
  await writeLedger(path.join(HOME, ".agent-daemon"), { schemaVersion: 1, hosts: {} });
});

test("a payload heading quoted in the prose doesn't break the proposal", async () => {
  const { parseProposal } = await import("../src/skills/proposal.mjs");
  const text = renderSkillProposal({ skill: "demo-skill", base: "a".repeat(64), body: A("demo-skill"), origin: "gepa", why: "The reflection said:\n## Proposed SKILL.md\n```markdown\na shorter one\n```\nshould be shorter." });
  const p = parseProposal(text);
  assert.equal(p.error, undefined);
  assert.equal(p.body, A("demo-skill"));
});

test("a project copy wins: the skill loaded from <cwd>/.claude/skills is the one updated", async () => {
  const s = await setup();
  const projectCopy = path.join(s.cwd, ".claude", "skills", s.name);
  await fs.cp(s.bundledDir, projectCopy, { recursive: true });
  const r = await lib.applySkillProposal(s.file, s.opts);
  assert.equal(r.ok, true, r.text);
  assert.equal(read(path.join(projectCopy, "SKILL.md")), B(s.name));
  assert.equal(read(path.join(s.installed, "SKILL.md")), A(s.name), "the global copy isn't the one this project loads");
  assert.deepEqual(readdirSync(path.join(s.cwd, ".claude", "skills", s.name)).sort(), ["SKILL.md", "helper.txt"]);
});
