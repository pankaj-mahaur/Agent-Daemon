// P8.1: the claims lint. Each must-fail sentence is caught by its rule; the approved forms pass.

import { test } from "node:test";
import assert from "node:assert/strict";
import { APPROVED_CROSS, checkClaims, readMatrix, renderHosts } from "../scripts/check-claims.mjs";

const live = ["Claude Code", "Cursor"];
const rules = (s, o = {}) => checkClaims(s, { testedLive: live, hosts: ["Claude Code", "Cursor", "Windsurf"], ...o }).map((f) => f.rule);

test("must fail: banned words, a number without a link or a baseline, an untested host, 'reviewed lessons', 'never … another project'", () => {
  assert.deepEqual(rules("The #1 memory for agents."), ["banned"]);
  assert.deepEqual(rules("SOTA recall for your agent."), ["banned"]);
  assert.deepEqual(rules("It cuts mistakes by 60%."), ["number"]);
  assert.deepEqual(rules("Repeated mistakes fell by 52% ([report](docs/benchmark/report.md))."), ["number"], "a link but no baseline");
  assert.deepEqual(rules("Works in Claude Code, Cursor and Windsurf."), ["host:Windsurf"]);
  assert.deepEqual(rules("Windsurf users get it too."), ["host:Windsurf"], "any sentence, not only after 'works with'");
  assert.deepEqual(rules("It serves them back as reviewed lessons."), ["reviewed"]);
  assert.deepEqual(rules("ad never reads another project's memory."), ["cross"]);
  assert.deepEqual(rules("Recall is 3x faster."), ["number"]);
});

test("must pass: a number with its link and baseline, rendered hosts, skills you approve, the approved sentence, code blocks", () => {
  assert.deepEqual(rules("Repeated mistakes fell by 52% compared with no memory ([report](docs/benchmark/report.md))."), []);
  assert.deepEqual(rules(renderHosts("Install once; {{hosts}} share it.", live)), []);
  assert.equal(renderHosts("{{hosts}}", live), "Claude Code, Cursor");
  assert.deepEqual(rules("Skills you approve install in every agent you use."), []);
  assert.deepEqual(rules("Notes an agent writes for itself wait for your review, as reviewed notes from the agent."), []);
  assert.deepEqual(rules(`${APPROVED_CROSS}.`), []);
  assert.deepEqual(rules("```\nad memory report --best 60%\n```"), [], "commands are not claims");
});

test("the support matrix gives the host list and the tested-live rows", () => {
  const m = readMatrix();
  assert.ok(m.hosts.length >= 5, m.hosts.join());
  assert.ok(m.testedLive.length >= 1);
  assert.ok(m.testedLive.every((h) => m.hosts.includes(h)));
});
