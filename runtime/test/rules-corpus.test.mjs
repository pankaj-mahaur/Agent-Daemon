// L4c gates on the held-out corpora (frozen in L0). Plan D29: the
// implementer never reads the corpora item by item, so these tests report
// only totals, never which items failed. Tune on test/fixtures/rules/.
//
//   correction → pattern: derivation accuracy >= 0.8
//   guards (command and write rules): must-block 0 misses, must-allow <= 2% matched
// The guards corpus's self-protection items are L7's gate (the built-in rule).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { deriveRule } from "../src/rules/derive.mjs";
import { matchRule } from "../src/rules/match.mjs";
import { derivationCorrect, guardCase } from "../testkit/rule-examples.mjs";

const read = (rel) =>
  readFileSync(fileURLToPath(new URL(`./corpora/${rel}`, import.meta.url)), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));

test("held-out correction → pattern corpus: derivation accuracy >= 0.8", () => {
  const items = read("correction-pattern/correction-pattern.jsonl");
  let ok = 0;
  let rules = 0;
  let reminders = 0;
  for (const it of items) {
    const good = derivationCorrect(it, deriveRule(it.correction), matchRule);
    if (!good) continue;
    ok++;
    if (it.expected.type === "not-a-rule") reminders++;
    else rules++;
  }
  const accuracy = ok / items.length;
  console.log(`correction-pattern corpus: ${ok}/${items.length} = ${accuracy.toFixed(3)} (rules right ${rules}, reminders right ${reminders})`);
  assert.ok(accuracy >= 0.8, `accuracy ${accuracy.toFixed(3)} < 0.8`);
});

test("held-out guards corpus (command and write rules): 0 missed blocks, <= 2% matched allows", () => {
  const blocks = read("guards/must-block.jsonl").filter((it) => it.rule.type !== "self-protection");
  const allows = read("guards/must-allow.jsonl").filter((it) => it.rule.type !== "self-protection");
  let missed = 0;
  let falsePositives = 0;
  for (const it of blocks) {
    const { rule, call } = guardCase(it);
    if (!matchRule(rule, call).match) missed++;
  }
  for (const it of allows) {
    const { rule, call } = guardCase(it);
    if (matchRule(rule, call).match) falsePositives++;
  }
  const fpRate = falsePositives / allows.length;
  console.log(`guards corpus: must-block ${blocks.length - missed}/${blocks.length} (missed ${missed}), must-allow matched ${falsePositives}/${allows.length} (${(fpRate * 100).toFixed(1)}%)`);
  assert.equal(missed, 0, `${missed} must-block calls not matched`);
  assert.ok(fpRate <= 0.02, `${falsePositives} must-allow calls matched (${(fpRate * 100).toFixed(1)}%)`);
});
