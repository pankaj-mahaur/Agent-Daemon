// P7.4: the ad-state-migrate skill. Every ad command it names exists with the flags it uses; its
// frontmatter and guardrails hold; and its own sequence, run in throwaway homes, moves a project
// and back again (the dual-boot repeat move) with recall both ways.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeStateFixture } from "../testkit/state-fixture.mjs";
import { cmdState, STATE_OPTIONS, STATE_SUBCOMMANDS } from "../src/portability/state-cli.mjs";
import { reviewImport } from "../src/portability/import.mjs";

const SKILL = fileURLToPath(new URL("../../skills/daemon/ad-state-migrate/SKILL.md", import.meta.url));
const CLI = fileURLToPath(new URL("../src/cli-full.mjs", import.meta.url));
const text = fs.readFileSync(SKILL, "utf8");
const cli = fs.readFileSync(CLI, "utf8");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ad-skill-migrate-"));
after(() => fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

// Every `ad …` command in a code span.
const commands = [...text.matchAll(/`(ad [^`]+)`/g)].map((m) => m[1]);

test("frontmatter: the name matches the folder; the description starts with 'Use when' and fits 500 characters", () => {
  const fm = /^---\n([\s\S]*?)\n---/.exec(text.replace(/\r\n/g, "\n"))[1];
  assert.match(fm, /^name: ad-state-migrate$/m);
  const desc = JSON.parse(/^description: (".*")$/m.exec(fm)[1]);
  assert.ok(desc.startsWith("Use when"), desc.slice(0, 20));
  assert.ok(desc.length <= 500, `${desc.length}`);
});

test("every guardrail is there, and nothing personal", () => {
  for (const g of ["Never extract or edit a bundle by hand", "never copy `~/.agent-daemon`", "Never read `secrets/`", "never ask for a key in chat", "Never delete or change the state on the side being left", "Never claim the move worked without `ad state verify --import`", "`--force-tracked` or `--accept-held` without the user's explicit yes", "Never run `ad review --import`, `--accept-all` or `ad memory promote` yourself", "Never put the bundle in a synced or shared cloud folder, or in git"]) {
    assert.ok(text.includes(g), g);
  }
  assert.doesNotMatch(text, /C:\\Users\\|\/home\/[a-z]+\/|my-projects/i);
});

test("every ad command the skill names exists, with the flags it uses", () => {
  assert.ok(commands.length > 15, `${commands.length}`);
  const known = new Set([...cli.matchAll(/case "([a-z-]+)":/g)].map((m) => m[1]));
  const options = new Set([...cli.matchAll(/^\s+"?([a-z][a-z-]*)"?:\s+\{ type:/gm)].map((m) => m[1]));
  for (const c of commands) {
    const words = c.split(/\s+/);
    const sub = words[1];
    if (sub === "--version") continue;
    if (sub === "state" && !words[2]) continue; // "ad state" named in prose
    if (sub === "state") {
      assert.ok(STATE_SUBCOMMANDS.includes(words[2]), `ad state ${words[2]}`);
      for (const f of c.match(/--[a-z-]+/g) ?? []) assert.ok(Object.hasOwn(STATE_OPTIONS, f.slice(2)), `${c}: ${f}`);
      continue;
    }
    assert.ok(known.has(sub) || sub === "state", `${c}: no ad ${sub}`);
    for (const f of c.match(/--[a-z-]+/g) ?? []) assert.ok(options.has(f.slice(2)), `${c}: ${f}`);
  }
  assert.ok(commands.some((c) => c.startsWith("ad review --import")), "the review step is named");
});

test("the skill's own sequence: a first move and a repeat move back with keep-both, recall N/N both ways, nothing lost", async () => {
  const sink = () => {
    const s = { text: "", write: (c) => ((s.text += c), true) };
    return s;
  };
  // Side being left (this fixture's home), side being moved to (an empty home with a clone elsewhere).
  const left = await makeStateFixture({ root: fs.mkdtempSync(path.join(TMP, "left-")), keyish: false });
  const rootB = fs.mkdtempSync(path.join(TMP, "right-"));
  const envB = { ...process.env, AD_ROOT: path.join(rootB, ".agent-daemon"), HOME: rootB, USERPROFILE: rootB };
  for (const k of ["AD_TOOL_SHELL", "AD_INTERNAL_TEST_CONFIRM"]) delete envB[k];
  const cloneB = path.join(rootB, "src", "app-a");
  fs.mkdirSync(cloneB, { recursive: true });
  const run = async (args, env) => {
    const out = sink();
    const err = sink();
    const code = await cmdState(args, { out, err, env });
    return { code, out: out.text, err: err.text };
  };
  // 1–3: inspect, export, verify.
  assert.equal((await run(["inspect", "--all-projects"], left.env)).code, 0);
  const file = path.join(TMP, "move.adstate");
  const ex = await run(["export", "--out", file, "--project", left.A.dir], left.env);
  assert.equal(ex.code, 0, ex.err);
  assert.match(ex.out, /This file is not encrypted/);
  assert.match((await run(["verify", file], left.env)).out, /no problem found/);
  // 7–9: dry run, import, verify --import.
  assert.match((await run(["import", file, "--dry-run", "--map", `app-a=${cloneB}`], envB)).out, /Nothing has been written/);
  const imp = await run(["import", file, "--map", `app-a=${cloneB}`], envB);
  assert.equal(imp.code, 0, imp.err);
  const id = /Imported \((imp_[0-9A-Z]+)\)/.exec(imp.out)[1];
  const v = await run(["verify", "--import", id], envB);
  assert.match(v.out, /Recall: 3\/3 lessons found in app-a/);
  // 10: the user's review (here through the internal override: the walk has no terminal).
  await reviewImport(id, { acceptAll: true, env: { ...envB, AD_INTERNAL_TEST_CONFIRM: id }, isTTY: false, out: sink() });
  // The repeat move: new work on the new side, then back to the old one with keep-both.
  fs.appendFileSync(path.join(cloneB, ".agent-daemon", "memory", "notes.md"), "added on the new side\n");
  const back = path.join(TMP, "back.adstate");
  const ex2 = await run(["export", "--out", back, "--project", cloneB], envB);
  assert.equal(ex2.code, 0, ex2.err);
  const imp2 = await run(["import", back, "--map", `app-a=${left.A.dir}`, "--on-conflict", "keep-both"], left.env);
  assert.equal(imp2.code, 0, imp2.err + imp2.out);
  const id2 = /Imported \((imp_[0-9A-Z]+)\)/.exec(imp2.out)[1];
  assert.match((await run(["verify", "--import", id2], left.env)).out, /Recall: \d+\/\d+ lessons found in app-a/);
  const mem = path.join(left.A.dir, ".agent-daemon", "memory");
  assert.match(fs.readFileSync(path.join(mem, "notes.md"), "utf8"), /SENTINEL-ALPHA-7781 lives here/, "the old side's own file is kept");
  assert.ok(fs.readdirSync(mem).some((f) => /^notes\.imported-\d{4}-\d{2}-\d{2}\.md$/.test(f)), "the new side's version beside it");
  // A corrupted bundle: verify fails, and the walk stops there.
  const bad = path.join(TMP, "bad.adstate");
  fs.writeFileSync(bad, fs.readFileSync(file).subarray(0, 200));
  assert.equal((await run(["verify", bad], left.env)).code, 1);
});
