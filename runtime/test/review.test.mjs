// P5.7a: ad review applies skill proposals. The loop shows a diff and, on a typed
// accept, applies and files the proposal; reject files it in rejected/; --reject works
// without a terminal; accepting and `ad skill undo` refuse in an agent's tool shell
// and without a terminal (D49), and there is no --yes.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = await fs.mkdtemp(path.join(os.tmpdir(), "ad-review-skill-"));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.AD_ROOT = path.join(HOME, ".agent-daemon");
for (const k of ["AD_MEMORY_DB", "AD_MEMORY_PROJECT", "CLAUDE_PROJECT_DIR", "AD_TOOL_SHELL", "CLAUDE_CONFIG_DIR", "CODEX_HOME"]) delete process.env[k];

const { renderSkillProposal, skillSha } = await import("../src/skills/proposal.mjs");
const { runInteractiveReview, listProposals } = await import("../src/review.mjs");
const { runSkillCommand } = await import("../src/skills/cli.mjs");
const ep = await import("../src/memory/episodic.mjs");

let handle;
before(async () => {
  handle = await ep.db();
});
after(async () => {
  ep.closeDb();
  await fs.rm(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const skill = (name, d) => `---\nname: ${name}\ndescription: Use when testing ad review (${d}).\n---\n\n# ${name}\n\nSteps.\n`;
let n = 0;
async function setup() {
  const name = `review-skill-${++n}`;
  const installed = path.join(HOME, ".claude", "skills", name);
  await fs.mkdir(installed, { recursive: true });
  await fs.writeFile(path.join(installed, "SKILL.md"), skill(name, "A"));
  const cwd = path.join(HOME, "work", `p${n}`);
  await fs.mkdir(path.join(cwd, ".agent-daemon", "proposed"), { recursive: true });
  await fs.mkdir(path.join(cwd, ".git"), { recursive: true });
  const file = path.join(cwd, ".agent-daemon", "proposed", `skill-${name}-1.md`);
  await fs.writeFile(file, renderSkillProposal({ skill: name, base: skillSha(skill(name, "A")), body: skill(name, "B"), origin: "gepa", run: "r1" }));
  return { name, installed, cwd, file };
}
const answers = (...a) => ({ ask: async () => a.shift() ?? "q" });
const lines = () => {
  const l = [];
  return { l, out: (x) => l.push(String(x)) };
};
const tty = { isTTY: () => true, env: {} };

test("the loop shows the diff; a typed accept applies it, prints the version and hosts, and files the proposal", async () => {
  const s = await setup();
  const o = lines();
  const code = await runInteractiveReview({ cwd: s.cwd, io: answers("a", "accept"), out: o.out, handle, ...tty });
  assert.equal(code, 0);
  const text = o.l.join("\n");
  assert.match(text, /-description: Use when testing ad review \(A\)\.\n\+description: Use when testing ad review \(B\)\./);
  assert.match(text, new RegExp(`✓ ${s.name} v2 accepted and published to: Claude Code, ad\\. Undo: ad skill undo ${s.name}`));
  assert.match(readFileSync(path.join(s.installed, "SKILL.md"), "utf8"), /\(B\)/);
  assert.ok(!existsSync(s.file));
  assert.ok(existsSync(path.join(s.cwd, ".agent-daemon", "applied", path.basename(s.file))));
  assert.equal(handle.get("SELECT status FROM proposals WHERE title = ?", [path.basename(s.file)]).status, "accepted");
  assert.doesNotMatch(text, /manual SKILL\.md update/);
});

test("a proposal swapped while the user reads it is not applied", async () => {
  const s = await setup();
  const o = lines();
  const asks = ["a"];
  const io = {
    ask: async (q) => {
      if (/Type accept/.test(q)) {
        await fs.writeFile(s.file, renderSkillProposal({ skill: s.name, base: skillSha(skill(s.name, "A")), body: skill(s.name, "SWAPPED"), origin: "gepa" }));
        return "accept";
      }
      return asks.shift() ?? "q";
    },
  };
  await runInteractiveReview({ cwd: s.cwd, io, out: o.out, handle, ...tty });
  assert.match(o.l.join("\n"), /changed while you were reading it, so nothing was applied/);
  assert.match(readFileSync(path.join(s.installed, "SKILL.md"), "utf8"), /\(A\)/);
});

test("not typing accept changes nothing; reject files it in rejected/ with a proposals row", async () => {
  const s = await setup();
  const o = lines();
  await runInteractiveReview({ cwd: s.cwd, io: answers("a", "yes"), out: o.out, handle, ...tty });
  assert.match(o.l.join("\n"), /not confirmed/);
  assert.ok(existsSync(s.file));
  assert.match(readFileSync(path.join(s.installed, "SKILL.md"), "utf8"), /\(A\)/);
  await runInteractiveReview({ cwd: s.cwd, io: answers("r"), out: o.out, handle, ...tty });
  assert.ok(!existsSync(s.file));
  assert.ok(existsSync(path.join(s.cwd, ".agent-daemon", "rejected", path.basename(s.file))));
  assert.equal(handle.get("SELECT status FROM proposals WHERE title = ?", [path.basename(s.file)]).status, "rejected");
});

test("an agent's tool shell or no terminal: accepting a skill proposal and undo exit 2 and change nothing; --yes is refused", async () => {
  const s = await setup();
  for (const opts of [{ env: { AD_TOOL_SHELL: "1" }, isTTY: () => true }, { env: {}, isTTY: () => false }]) {
    const o = lines();
    assert.equal(await runInteractiveReview({ cwd: s.cwd, accept: path.basename(s.file), io: answers("accept"), out: o.out, handle, ...opts }), 2);
    // The loop's accept is guarded too.
    if (opts.isTTY()) assert.equal(await runInteractiveReview({ cwd: s.cwd, io: answers("a", "accept"), out: o.out, handle, ...opts }), 2);
    assert.ok(existsSync(s.file));
    assert.match(readFileSync(path.join(s.installed, "SKILL.md"), "utf8"), /\(A\)/);
  }
  const o = lines();
  assert.equal(await runInteractiveReview({ cwd: s.cwd, accept: path.basename(s.file), yes: true, io: answers("accept"), out: o.out, handle, ...tty }), 2);
  // --accept <file> at a real terminal: shown, then confirmed.
  const ok = lines();
  assert.equal(await runInteractiveReview({ cwd: s.cwd, accept: path.basename(s.file), io: answers("accept"), out: ok.out, handle, ...tty }), 0);
  assert.match(readFileSync(path.join(s.installed, "SKILL.md"), "utf8"), /\(B\)/);
  // undo: guarded the same way, then typed.
  for (const opts of [{ env: { AD_TOOL_SHELL: "1" }, isTTY: () => true }, { env: {}, isTTY: () => false }]) {
    const e = lines();
    assert.equal(await runSkillCommand("undo", { name: s.name, cwd: s.cwd, io: answers("undo"), out: e.out, err: e.out, ...opts }), 2);
    assert.match(readFileSync(path.join(s.installed, "SKILL.md"), "utf8"), /\(B\)/);
  }
  const y = lines();
  assert.equal(await runSkillCommand("undo", { name: s.name, cwd: s.cwd, yes: true, io: answers("undo"), out: y.out, err: y.out, ...tty }), 2);
  const u = lines();
  assert.equal(await runSkillCommand("undo", { name: s.name, cwd: s.cwd, io: answers("undo"), out: u.out, err: u.out, ...tty }), 0, u.l.join("\n"));
  assert.match(readFileSync(path.join(s.installed, "SKILL.md"), "utf8"), /\(A\)/);
});

test("without a terminal: --list lists, --reject <file> rejects; both queues are listed", async () => {
  const s = await setup();
  const global = path.join(HOME, ".agent-daemon", "proposed", "_global");
  await fs.mkdir(global, { recursive: true });
  await fs.writeFile(path.join(global, "constitution-add-x.md"), "# Proposal\n");
  assert.deepEqual((await listProposals(s.cwd)).map((e) => e.name), [path.basename(s.file), "constitution-add-x.md"]);
  const o = lines();
  assert.equal(await runInteractiveReview({ cwd: s.cwd, list: true, out: o.out, handle, env: {}, isTTY: () => false }), 0);
  assert.match(o.l.join("\n"), /2 queued proposal\(s\):/);
  assert.equal(await runInteractiveReview({ cwd: s.cwd, reject: path.basename(s.file), out: o.out, handle, env: { AD_TOOL_SHELL: "1" }, isTTY: () => false }), 2, "not from an agent's shell");
  assert.ok(existsSync(s.file));
  assert.equal(await runInteractiveReview({ cwd: s.cwd, reject: path.basename(s.file), out: o.out, handle, env: {}, isTTY: () => false }), 0);
  assert.ok(existsSync(path.join(s.cwd, ".agent-daemon", "rejected", path.basename(s.file))));
  await fs.rm(path.join(global, "constitution-add-x.md"));
});

test("a lesson with no skill named: review asks which; Enter leaves it queued", async () => {
  const s = await setup();
  await fs.writeFile(s.file, renderSkillProposal({ kind: "skill-lesson", body: "Prefer pnpm.", origin: "digest" }));
  const o = lines();
  await runInteractiveReview({ cwd: s.cwd, io: answers("a", ""), out: o.out, handle, ...tty });
  assert.match(o.l.join("\n"), /left queued/);
  assert.ok(existsSync(s.file));
  await runInteractiveReview({ cwd: s.cwd, io: answers("a", s.name, "accept"), out: o.out, handle, ...tty });
  assert.match(readFileSync(path.join(s.installed, "SKILL.md"), "utf8"), /## Learned from use\n\n- Prefer pnpm\./);
});

test("ad skill propose queues a v1 proposal against the loaded copy; history and diff read the library", async () => {
  const s = await setup();
  await fs.rm(s.file);
  const draft = path.join(s.cwd, "draft.md");
  await fs.writeFile(draft, skill(s.name, "C"));
  const o = lines();
  assert.equal(await runSkillCommand("propose", { name: s.name, cwd: s.cwd, file: "draft.md", out: o.out, err: o.out }), 0, o.l.join("\n"));
  const [queued] = await listProposals(s.cwd);
  const text = readFileSync(queued.file, "utf8");
  assert.match(text, /^origin: gepa-inline$/m);
  assert.match(text, new RegExp(`^base-sha256: ${skillSha(skill(s.name, "A"))}$`, "m"));
  assert.match(readFileSync(path.join(s.installed, "SKILL.md"), "utf8"), /\(A\)/, "propose applies nothing");
  await runInteractiveReview({ cwd: s.cwd, io: answers("a", "accept"), out: o.out, handle, ...tty });
  const h = lines();
  await runSkillCommand("history", { name: s.name, out: h.out });
  assert.match(h.l.join("\n"), /v1 .* the copy before the first accept\n {2}v2 .* accepted \(gepa-inline\)/);
  const d = lines();
  await runSkillCommand("diff", { name: s.name, out: d.out });
  assert.match(d.l.join("\n"), /\+description: Use when testing ad review \(C\)\./);
});
