// L3 Decision 20, Codex: setup writes the command skills ($CODEX_HOME/skills/<pkg>-remember|
// recall|report) with ad's marker and ledgers each folder; uninstall removes only ad's
// unchanged folders; a folder of that name that isn't ad's, or that the user edited, is
// never overwritten or removed; doctor flags a name Codex finds twice. Temp homes only.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { makeContext, uninstall } = await import("../src/memory-install/install.mjs");
const S = await import("../src/memory-install/setup.mjs");
const K = await import("../src/memory-install/codex-skills.mjs");
const { productChecks } = await import("../src/memory-install/doctor-product.mjs");
const { readLedger2, openLedger2ForWrite, upsertItem, writeLedger2 } = await import("../src/memory-install/ledger2.mjs");
const { PRODUCT } = await import("../src/product.mjs");

const made = [];
after(() => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
const NAMES = ["remember", "recall", "report"].map((c) => `${PRODUCT.package}-${c}`);

function home() {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), "ad-codex-skills-"));
  made.push(h);
  const codex = path.join(h, ".codex");
  fs.mkdirSync(codex, { recursive: true });
  fs.writeFileSync(path.join(codex, "config.toml"), 'model = "gpt-5"\n');
  const adRoot = path.join(h, ".agent-daemon");
  const env = { HOME: h, USERPROFILE: h, CODEX_HOME: codex, CLAUDE_CONFIG_DIR: path.join(h, ".claude-none"), AD_ROOT: adRoot, PATH: process.env.PATH, SystemRoot: process.env.SystemRoot };
  const lines = [];
  const ctx = makeContext({
    env, home: h, root: adRoot, viaLauncher: true, platform: "linux",
    resolve: () => null, out: (l) => lines.push(String(l)), ask: async () => "",
    isTTY: () => true, claudeVersion: async () => "2.1.319", rulesExist: () => false, confirmReview: async () => false, lockWaitMs: 50,
  });
  const skills = path.join(codex, "skills");
  return { h, env, ctx, lines, text: () => lines.join("\n"), skills, dir: (n) => path.join(skills, n), adRoot };
}
const skillItems = (t) => readLedger2(t.adRoot).items.filter((i) => i.kind === "skill-dir");
const snapshot = (dir) => Object.fromEntries(fs.readdirSync(dir, { recursive: true }).filter((f) => fs.statSync(path.join(dir, f)).isFile()).map((f) => [f, fs.readFileSync(path.join(dir, f), "utf8")]));

test("setup writes the three skills with ad's marker and ledgers them; a re-run changes nothing; uninstall removes them", async () => {
  const t = home();
  assert.equal(await S.setup({ ctx: t.ctx, hosts: ["codex"] }), 0, t.text());
  for (const n of NAMES) {
    assert.deepEqual(Object.keys(snapshot(t.dir(n))).sort(),[K.SKILL_MARKER, "SKILL.md", path.join("agents", "openai.yaml")].sort(), n);
    assert.match(fs.readFileSync(path.join(t.dir(n), "agents", "openai.yaml"), "utf8"), /allow_implicit_invocation: false/);
  }
  assert.ok(fs.readFileSync(path.join(t.dir(NAMES[0]), "SKILL.md"), "utf8").includes(`npx -y ${PRODUCT.package}@${t.ctx.version} review`), "the commands setup prints, pinned");
  assert.ok(fs.readFileSync(path.join(t.dir(NAMES[2]), "SKILL.md"), "utf8").includes(`node "${path.join(t.adRoot, "memory", "launch", "run.mjs").replace(/\\/g, "/")}" report`), "report runs through the launcher, offline");
  assert.match(t.text(), /✓ Codex: the skill \$agent-daemon-memory-remember added in/);
  const items = skillItems(t);
  assert.deepEqual(items.map((i) => i.locator.name).sort(), [...NAMES].sort());
  assert.ok(items.every((i) => i.host === "codex" && !i.preExisted && !i.source));
  const before = NAMES.map((n) => snapshot(t.dir(n)));
  t.lines.length = 0;
  assert.equal(await S.setup({ ctx: t.ctx, hosts: ["codex"] }), 0, t.text());
  assert.deepEqual(NAMES.map((n) => snapshot(t.dir(n))), before, "the same bytes, marker included");
  assert.doesNotMatch(t.text(), /skill .* (added|updated)/);
  t.lines.length = 0;
  assert.equal(await uninstall({ ctx: t.ctx, hosts: ["codex"] }), 0, t.text());
  for (const n of NAMES) assert.ok(!fs.existsSync(t.dir(n)), n);
  assert.deepEqual(skillItems(t), []);
  assert.match(t.text(), new RegExp(`Removed:[\\s\\S]*${NAMES[0]}`));
});

test("a folder of that name that isn't ad's is left alone, by setup and by uninstall", async () => {
  const t = home();
  const mine = t.dir(NAMES[1]);
  fs.mkdirSync(mine, { recursive: true });
  fs.writeFileSync(path.join(mine, "SKILL.md"), "---\nname: mine\ndescription: my own recall\n---\nmine\n");
  assert.equal(await S.setup({ ctx: t.ctx, hosts: ["codex"] }), 0, t.text());
  assert.equal(fs.readFileSync(path.join(mine, "SKILL.md"), "utf8"), "---\nname: mine\ndescription: my own recall\n---\nmine\n");
  assert.match(t.text(), /the skill \$agent-daemon-memory-recall: .* is a skill of that name that isn't ad's; left as it is\. To use ad's, remove that folder/);
  assert.deepEqual(skillItems(t).map((i) => i.locator.name).sort(), [NAMES[0], NAMES[2]].sort(), "only ad's folders are ledgered");
  // A forged record for it (a ledger edited by hand): no marker, so uninstall keeps the folder.
  const opened = openLedger2ForWrite(t.adRoot);
  upsertItem(opened.ledger, { host: "codex", kind: "skill-dir", file: mine, locator: { name: NAMES[1] }, value: { sha256: K.liveSkill(mine, NAMES[1]).sha256 } });
  await writeLedger2(t.adRoot, opened.ledger);
  assert.equal(await uninstall({ ctx: t.ctx, hosts: ["codex"] }), 0, t.text());
  assert.ok(fs.existsSync(path.join(mine, "SKILL.md")), "the user's folder stays");
  assert.match(t.text(), /Kept:[\s\S]*agent-daemon-memory-recall: it isn't ad's/);
  assert.ok(!fs.existsSync(t.dir(NAMES[0])) && !fs.existsSync(t.dir(NAMES[2])));
});

test("a folder the user edited after setup: setup doesn't overwrite it, uninstall keeps it and says how to remove it", async () => {
  const t = home();
  assert.equal(await S.setup({ ctx: t.ctx, hosts: ["codex"] }), 0, t.text());
  const yaml = path.join(t.dir(NAMES[0]), "agents", "openai.yaml");
  fs.writeFileSync(yaml, fs.readFileSync(yaml, "utf8").replace("allow_implicit_invocation: false", "allow_implicit_invocation: true"));
  const edited = snapshot(t.dir(NAMES[0]));
  t.lines.length = 0;
  assert.equal(await S.setup({ ctx: t.ctx, hosts: ["codex"] }), 0, t.text());
  assert.deepEqual(snapshot(t.dir(NAMES[0])), edited);
  assert.match(t.text(), /\$agent-daemon-memory-remember: .* is you changed it/);
  t.lines.length = 0;
  assert.equal(await uninstall({ ctx: t.ctx, hosts: ["codex"] }), 0, t.text());
  assert.deepEqual(snapshot(t.dir(NAMES[0])), edited, "kept as the user left it");
  assert.match(t.text(), /Kept:[\s\S]*agent-daemon-memory-remember: you changed it\. To remove it: delete the folder/);
  assert.deepEqual(skillItems(t), [], "the kept folder is the user's now");
});

test("an older version's folder that is still ad's and unchanged is updated in place", async () => {
  const t = home();
  assert.equal(await S.setup({ ctx: t.ctx, hosts: ["codex"] }), 0, t.text());
  // As an older setup left it: different text, its own marker sha.
  const dir = t.dir(NAMES[0]);
  const old = fs.readFileSync(path.join(dir, "SKILL.md"), "utf8").replace(`@${t.ctx.version} `, "@0.9.0 ");
  fs.writeFileSync(path.join(dir, "SKILL.md"), old);
  fs.writeFileSync(path.join(dir, "notes.md"), "a file the older version had\n");
  const m = JSON.parse(fs.readFileSync(path.join(dir, K.SKILL_MARKER), "utf8"));
  fs.writeFileSync(path.join(dir, K.SKILL_MARKER), JSON.stringify({ ...m, version: "0.9.0", sha256: K.liveSkill(dir, NAMES[0]).sha256 }));
  t.lines.length = 0;
  assert.equal(await S.setup({ ctx: t.ctx, hosts: ["codex"] }), 0, t.text());
  assert.match(t.text(), /\$agent-daemon-memory-remember updated in/);
  assert.ok(fs.readFileSync(path.join(dir, "SKILL.md"), "utf8").includes(`@${t.ctx.version} `));
  assert.ok(!fs.existsSync(path.join(dir, "notes.md")), "a file the new version dropped doesn't linger (it would read as the user's change)");
  assert.equal(await uninstall({ ctx: t.ctx, hosts: ["codex"] }), 0, t.text());
  assert.ok(!fs.existsSync(dir), "the updated folder is recorded under its new content");
});

test("a record pointing outside Codex's skills folder is never removed; a dry run writes nothing; pending lists missing skills", async () => {
  const t = home();
  assert.equal(await S.setup({ ctx: t.ctx, hosts: ["codex"], dryRun: true }), 0, t.text());
  assert.ok(!fs.existsSync(t.skills), "dry run: nothing written");
  assert.match(t.text(), /would add the skill \$agent-daemon-memory-report/);
  const pending = await S.setupPending(t.ctx, "codex", { routes: [], marker: false, host: "codex" });
  assert.deepEqual(pending.filter((p) => p.kind === "skill-dir").map((p) => path.basename(p.file)).sort(), [...NAMES].sort());
  // ad's marker and name, but somewhere else: outside the host's skills folder.
  const elsewhere = path.join(t.h, "projects", NAMES[0]);
  fs.mkdirSync(elsewhere, { recursive: true });
  fs.writeFileSync(path.join(elsewhere, "SKILL.md"), "x\n");
  fs.writeFileSync(path.join(elsewhere, K.SKILL_MARKER), JSON.stringify({ name: NAMES[0], sha256: K.liveSkill(elsewhere, NAMES[0]).sha256 }));
  const opened = openLedger2ForWrite(t.adRoot);
  upsertItem(opened.ledger, { host: "codex", kind: "skill-dir", file: elsewhere, locator: { name: NAMES[0] }, value: { sha256: K.liveSkill(elsewhere, NAMES[0]).sha256 } });
  await writeLedger2(t.adRoot, opened.ledger);
  assert.equal(await uninstall({ ctx: t.ctx, hosts: ["codex"] }), 0, t.text());
  assert.ok(fs.existsSync(path.join(elsewhere, "SKILL.md")));
  assert.match(t.text(), /it isn't in a host's skills folder/);
});

test("no skills where setup refused the hooks (a root Codex's shell would misread)", async () => {
  const t = home();
  const weird = path.join(t.h, "a$b", ".agent-daemon");
  t.ctx.root = weird;
  t.env.AD_ROOT = weird;
  assert.equal(await S.setup({ ctx: t.ctx, hosts: ["codex"] }), 2, t.text());
  assert.match(t.text(), /no hooks:/);
  assert.ok(!fs.existsSync(t.skills), "no report skill with that root in its command line");
});

test("doctor: a command skill Codex finds twice (its folder and ~/.agents/skills) is flagged; none, no row", async () => {
  const t = home();
  assert.equal(await S.setup({ ctx: t.ctx, hosts: ["codex"] }), 0, t.text());
  assert.deepEqual((await productChecks(t.ctx, { claudeVersion: async () => null })).filter((c) => c.code === "skills.duplicate"), []);
  fs.cpSync(t.dir(NAMES[1]), path.join(t.h, ".agents", "skills", NAMES[1]), { recursive: true });
  const [row] = (await productChecks(t.ctx, { claudeVersion: async () => null })).filter((c) => c.code === "skills.duplicate");
  assert.equal(row.ok, false);
  assert.match(row.note, /agent-daemon-memory-recall is in .*\.agents.skills too, so Codex lists it twice/);
});
