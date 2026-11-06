// L4a gate on the held-out extractor corpus (frozen in L0): precision >= 0.85
// and recall >= 0.6 on `is_correction`. Plan D29: the implementer never reads
// the corpus item by item, so this test reports only the totals, never which
// prompts were missed. Tune on test/fixtures/mistakes/dev-prompts.jsonl.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { classifyPrompt } from "../src/mistakes/classify.mjs";

const file = fileURLToPath(new URL("./corpora/extractor/extractor.jsonl", import.meta.url));

test("held-out extractor corpus: precision >= 0.85, recall >= 0.6", () => {
  const items = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  let tp = 0;
  let fp = 0;
  let fn = 0;
  for (const it of items) {
    const got = classifyPrompt(it.prompt).correction;
    if (got && it.is_correction) tp++;
    else if (got) fp++;
    else if (it.is_correction) fn++;
  }
  const precision = tp / (tp + fp);
  const recall = tp / (tp + fn);
  console.log(`extractor corpus: n=${items.length} precision=${precision.toFixed(3)} recall=${recall.toFixed(3)} (tp=${tp} fp=${fp} fn=${fn})`);
  assert.ok(precision >= 0.85, `precision ${precision.toFixed(3)} < 0.85`);
  assert.ok(recall >= 0.6, `recall ${recall.toFixed(3)} < 0.6`);
});
