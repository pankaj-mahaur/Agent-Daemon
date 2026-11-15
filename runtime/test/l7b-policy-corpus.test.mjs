// L7b gate (04 §L7b Done-when): the starter safety policy on the L0 corpora.
//   must-block: 0 misses — every item fires its own family;
//   must-allow: at most 2% false positives — an item fires no family.
// The corpora are frozen (README): their hashes are checked first.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { firing } from "./fixtures/starter-policy-call.mjs";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "corpora", "starter-policy");
const HASHES = {
  "must-block.jsonl": "91379ba912fc2c62dfaf74d6e1440ba19b68a194da42018642294b68c15187e5",
  "must-allow.jsonl": "809cb4009c33f57b5b9d7fbe2e02395356bc0fbd867738951c7765116ac38fac",
  "ambiguous.jsonl": "a80f164a9458e2d371ab8007c8332e599126a05d9f8bd7243f36e56a5e71d572",
};
const read = (f) => fs.readFileSync(path.join(DIR, f), "utf8");
const items = (f) => read(f).split("\n").filter(Boolean).map((l) => JSON.parse(l));

test("the corpora are the frozen version 1", () => {
  for (const [f, h] of Object.entries(HASHES)) assert.equal(createHash("sha256").update(read(f)).digest("hex"), h, f);
});

test("must-block: every item fires its own family (0 misses)", () => {
  const all = items("must-block.jsonl");
  assert.ok(all.length >= 60);
  const misses = all.filter((it) => !firing(it).includes(it.family)).map((it) => `${it.id} ${it.family}: ${JSON.stringify(it.input)}`);
  assert.deepEqual(misses, []);
});

test("must-allow: at most 2% fire any family", () => {
  const all = items("must-allow.jsonl");
  assert.ok(all.length >= 100);
  const fps = all.map((it) => ({ it, f: firing(it) })).filter((x) => x.f.length).map((x) => `${x.it.id} → ${x.f.join(",")}: ${JSON.stringify(x.it.input)}`);
  assert.ok(fps.length <= Math.floor(all.length * 0.02), `false positives (${fps.length}):\n${fps.join("\n")}`);
});
