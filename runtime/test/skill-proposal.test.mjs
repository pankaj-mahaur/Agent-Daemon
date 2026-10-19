// P5.7: the skill proposal format v1. One file: frontmatter (ad-proposal: 1), prose,
// then the full proposed SKILL.md in a fence longer than any backtick run inside it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseProposal, renderSkillProposal, skillSha, PROPOSAL_TEXTS } from "../src/skills/proposal.mjs";

const SKILL = ["---", "name: demo-skill", "description: Use when testing proposals.", "---", "", "# Demo", "", "Steps.", ""].join("\n");

test("v1 round trip: meta and body come back as written", () => {
  const text = renderSkillProposal({ skill: "demo-skill", base: "a".repeat(64), body: SKILL, origin: "gepa", run: "run-1", host: "claude-code", created: "2026-10-19T00:00:00.000Z", why: "Scores 0.7 → 0.9." });
  assert.match(text, /^---\nad-proposal: 1\nkind: skill-update\nskill: demo-skill\n/);
  const p = parseProposal(text);
  assert.equal(p.legacy, false);
  assert.equal(p.error, undefined);
  assert.equal(p.body, SKILL);
  assert.deepEqual(
    { kind: p.meta.kind, skill: p.meta.skill, base: p.meta["base-sha256"], sha: p.meta["new-sha256"], origin: p.meta.origin, run: p.meta.run, host: p.meta.host },
    { kind: "skill-update", skill: "demo-skill", base: "a".repeat(64), sha: skillSha(SKILL), origin: "gepa", run: "run-1", host: "claude-code" },
  );
});

test("a body holding ``` and ```` fences comes back byte-identical", () => {
  const body = SKILL + "\n```js\nconst a = 1;\n```\n\n````markdown\n```\nnested\n```\n````\n";
  const text = renderSkillProposal({ skill: "demo-skill", base: "b".repeat(64), body, origin: "gepa-inline" });
  assert.match(text, /^`{5}markdown$/m, "the fence is one longer than the longest run inside");
  assert.equal(parseProposal(text).body, body);
  // Without a trailing newline, and with CRLF endings, too.
  for (const b of ["no newline at the end", "a\r\nb\r\n", ""]) assert.equal(parseProposal(renderSkillProposal({ skill: "demo-skill", base: "c".repeat(64), body: b, origin: "digest" })).body, b);
});

test("a wrong new-sha256 → the damaged text; line endings alone are not damage", () => {
  const text = renderSkillProposal({ skill: "demo-skill", base: "a".repeat(64), body: SKILL, origin: "gepa" });
  const damaged = text.replace("Steps.", "Steps!");
  assert.equal(parseProposal(damaged).error, PROPOSAL_TEXTS.damaged);
  assert.equal(PROPOSAL_TEXTS.damaged, "This proposal file is damaged (its content doesn't match its checksum).");
  const crlf = parseProposal(text.replace(/\n/g, "\r\n"));
  assert.equal(crlf.error, undefined);
  assert.equal(crlf.body.replace(/\r\n/g, "\n"), SKILL);
  assert.equal(skillSha("\u{FEFF}a\r\nb\r\n"), skillSha("a\nb\n"), "the checksum ignores a BOM and CRLF");
});

test("a skill name that isn't kebab-case is refused (it becomes a folder name)", () => {
  for (const bad of ["../evil", "Demo", "a/b", "a\\b", "", "con.", "-x"]) {
    assert.throws(() => renderSkillProposal({ skill: bad, base: "a".repeat(64), body: SKILL, origin: "gepa" }), /skill name/, bad);
  }
  const forged = renderSkillProposal({ skill: "demo-skill", base: "a".repeat(64), body: SKILL, origin: "gepa" }).replace("skill: demo-skill", "skill: ../../etc");
  assert.equal(parseProposal(forged).error, PROPOSAL_TEXTS.badName);
});

test("skill-lesson: a lesson for a named skill, or for none yet", () => {
  const p = parseProposal(renderSkillProposal({ kind: "skill-lesson", skill: "demo-skill", body: "Run the linter before committing.", origin: "digest", run: "s1" }));
  assert.deepEqual([p.meta.kind, p.meta.skill, p.body], ["skill-lesson", "demo-skill", "Run the linter before committing."]);
  const q = parseProposal(renderSkillProposal({ kind: "skill-lesson", body: "Prefer pnpm.", origin: "digest" }));
  assert.equal(q.meta.skill, undefined);
  assert.equal(q.body, "Prefer pnpm.");
});

test("frontmatter values are single lines: a newline can't add a key", () => {
  const text = renderSkillProposal({ skill: "demo-skill", base: "a".repeat(64), body: SKILL, origin: "gepa", run: "x\nkind: skill-lesson" });
  const p = parseProposal(text);
  assert.equal(p.meta.kind, "skill-update");
  assert.equal(p.meta.run, "x kind: skill-lesson");
});

test("the digest writes a skill lesson in the v1 format, naming the skill the classifier matched", async () => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const { classify } = await import("../src/digest/classify.mjs");
  const { writeProposal } = await import("../src/digest/proposals.mjs");
  const learning = { type: "pattern", scope: "project", text: "Run the linter\nbefore committing.", evidence_quote: "we lint first", evidence_speaker: "user", confidence: 0.9, tags: ["ci", "skill:debug-triage"] };
  const [item] = classify([learning], { availableSkills: ["debug-triage"] });
  assert.ok(item.targets.includes("skill-edit"));
  assert.equal(item.skill, "debug-triage");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ad-proposal-"));
  try {
    const file = await writeProposal({ item, proposedDir: dir, sessionId: "s-1", stamp: "2026-10-19T10:00:00.000Z" });
    assert.match(path.basename(file), /^skill-lesson-ci-2026-10-19T10-00-00-000Z\.md$/);
    const p = parseProposal(await fs.readFile(file, "utf8"));
    assert.deepEqual([p.legacy, p.meta.kind, p.meta.skill, p.meta.origin, p.meta.run, p.body], [false, "skill-lesson", "debug-triage", "digest", "s-1", "Run the linter before committing."]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("ad evolve writes v1: the parent's frontmatter on the winner body, the parent's checksum", async () => {
  const { renderProposal } = await import("../src/digest/gepa/evolve.mjs");
  const winnerBody = "# Demo\n\nBetter steps.\n\n```sh\nnpm test\n```\n";
  const w = (q, body) => ({ body, parentBaseline: 0.5, judgeRationale: "clearer", scores: { quality: q, size: body.length, compat: 1, testPass: 1 } });
  const text = renderProposal({ runId: "gepa-1", skillName: "demo-skill", parentBody: SKILL, winner: w(0.9, winnerBody), allWinners: [w(0.9, winnerBody), w(0.8, "alt ```` body\n")], reflections: { failureModes: [], summary: "ok" }, totalCostUsd: 0 });
  const p = parseProposal(text);
  assert.equal(p.legacy, false);
  assert.equal(p.error, undefined);
  assert.equal(p.meta["base-sha256"], skillSha(SKILL));
  assert.equal(p.meta.origin, "gepa");
  assert.equal(p.body, "---\nname: demo-skill\ndescription: Use when testing proposals.\n---\n\n" + winnerBody);
  assert.match(text, /Alternative 1/, "alternatives follow, outside the applied fence");
});

test("legacy shapes: ad evolve's winner body, /evolve's full file, garbage", () => {
  const evolve = ["# Proposed skill update — demo-skill", "", "Scores…", "", "## Winner body", "", "```markdown", "# Demo", "", "Better steps.", "```", "", "<details>alt</details>", ""].join("\n");
  const e = parseProposal(evolve);
  assert.deepEqual([e.legacy, e.meta.skill, e.body, e.bodyOnly], ["evolve", "demo-skill", "# Demo\n\nBetter steps.\n", true]);
  const inline = SKILL + "\n<!-- evolve-metadata -->\nscore: 0.9\n";
  const i = parseProposal(inline);
  assert.deepEqual([i.legacy, i.meta.skill, i.body, i.bodyOnly], ["evolve-inline", "demo-skill", SKILL, false]);
  const template = ["# Proposed: demo-skill", "", "## Proposed SKILL.md", "", "```markdown", SKILL.trimEnd(), "```", ""].join("\n");
  const t = parseProposal(template);
  assert.deepEqual([t.legacy, t.meta.skill, t.body], ["evolve-inline", "demo-skill", SKILL]);
  for (const g of ["", "just prose", "<!-- agent-daemon:proposal {\"kind\":\"memory-add\",\"learning\":1} -->\nx"]) assert.equal(parseProposal(g).legacy, "unknown", g);
});
