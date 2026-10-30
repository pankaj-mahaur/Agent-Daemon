// P5.7: a skill accepted from evidence in one host appears in the others. Claude
// Code's copy, ad's engine mirror, and the Codex and Gemini folders from the install
// ledger all get the accepted text; undo brings every one back.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = await fs.mkdtemp(path.join(os.tmpdir(), "ad-skill-xhost-"));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.AD_ROOT = path.join(HOME, ".agent-daemon");
for (const k of ["AD_MEMORY_DB", "AD_MEMORY_PROJECT", "CLAUDE_PROJECT_DIR", "AD_TOOL_SHELL", "CLAUDE_CONFIG_DIR", "CODEX_HOME"]) delete process.env[k];

const { renderSkillProposal, skillSha } = await import("../src/skills/proposal.mjs");
const { runInteractiveReview } = await import("../src/review.mjs");
const { runSkillCommand } = await import("../src/skills/cli.mjs");
const { syncSkills } = await import("../src/engine/codex/stock-ui.mjs");
const { writeLedger } = await import("../src/memory-install/ledger.mjs");
const ep = await import("../src/memory/episodic.mjs");
after(async () => {
  ep.closeDb();
  await fs.rm(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const skill = (d) => `---\nname: demo-skill\ndescription: Use when checking skills across hosts (${d}).\n---\n\n# Demo\n`;
const read = (p) => readFileSync(p, "utf8");

test("accepted once, present everywhere; undo restores everywhere", async () => {
  const claude = path.join(HOME, ".claude", "skills", "demo-skill");
  await fs.mkdir(claude, { recursive: true });
  await fs.writeFile(path.join(claude, "SKILL.md"), skill("A"));
  await writeLedger(path.join(HOME, ".agent-daemon"), { schemaVersion: 1, hosts: { "claude-code": { driver: "cli" }, codex: { driver: "file" }, gemini: { driver: "file" }, opencode: { driver: "file" } } });
  const cwd = path.join(HOME, "work", "shop-app");
  await fs.mkdir(path.join(cwd, ".agent-daemon", "proposed"), { recursive: true });
  await fs.mkdir(path.join(cwd, ".git"), { recursive: true });
  await fs.writeFile(path.join(cwd, ".agent-daemon", "proposed", "skill-demo-skill-1.md"), renderSkillProposal({ skill: "demo-skill", base: skillSha(skill("A")), body: skill("B"), origin: "gepa-inline", host: "claude-code" }));
  const asks = ["a", "accept"];
  const lines = [];
  const io = { ask: async () => asks.shift() ?? "q" };
  assert.equal(await runInteractiveReview({ cwd, io, out: (l) => lines.push(l), isTTY: () => true, env: {} }), 0, lines.join("\n"));

  const engineHome = path.join(HOME, "engine-home");
  const places = () => {
    syncSkills({ home: engineHome, from: path.join(HOME, ".claude", "skills") });
    return {
      "Claude Code": path.join(claude, "SKILL.md"),
      "ad (engine mirror)": path.join(engineHome, "skills", "demo-skill", "SKILL.md"),
      Codex: path.join(HOME, ".codex", "skills", "demo-skill", "SKILL.md"),
      "Gemini CLI": path.join(HOME, ".gemini", "skills", "demo-skill", "SKILL.md"),
    };
  };
  for (const [host, p] of Object.entries(places())) assert.equal(read(p), skill("B"), host);
  assert.equal(JSON.parse(read(path.join(HOME, ".codex", "skills", "demo-skill", ".ad-skill.json"))).version, 2);

  const u = [];
  assert.equal(await runSkillCommand("undo", { name: "demo-skill", cwd, io: { ask: async () => "undo" }, out: (l) => u.push(l), err: (l) => u.push(l), isTTY: () => true, env: {} }), 0, u.join("\n"));
  for (const [host, p] of Object.entries(places())) assert.equal(read(p), skill("A"), host);
  assert.equal(JSON.parse(read(path.join(HOME, ".gemini", "skills", "demo-skill", ".ad-skill.json"))).version, 3);
});
