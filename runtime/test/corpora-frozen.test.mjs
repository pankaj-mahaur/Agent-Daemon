// L0 (docs/plans/mcp-platform, D29): the held-out corpora under
// test/corpora/ are frozen. Each file must match the hash in MANIFEST.json,
// no file may appear or vanish unrecorded, and each gated file keeps its
// minimum size. A deliberate new corpus version regenerates the manifest:
//   node runtime/test/corpora-frozen.test.mjs --write-manifest
// and records the new hashes in the plan's progress file.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "corpora");
const MANIFEST = path.join(ROOT, "MANIFEST.json");

// Gated files and the L0 minimums (04-PARTS.md, L0 table).
const MINIMUMS = {
  "poisoning/poisoning.jsonl": 80,
  "extractor/extractor.jsonl": 150,
  "guards/must-block.jsonl": 80,
  "guards/must-allow.jsonl": 80,
  "starter-policy/must-block.jsonl": 60,
  "starter-policy/must-allow.jsonl": 100,
  "correction-pattern/correction-pattern.jsonl": 60,
  "prompt-recall/prompts.jsonl": 40,
};
const BRIEF_PROJECTS = 8;

const files = () => fs.readdirSync(ROOT, { recursive: true }).map((f) => f.split(path.sep).join("/")).filter((f) => f !== "MANIFEST.json" && fs.statSync(path.join(ROOT, f)).isFile()).sort();
// Hash LF-normalised text so a CRLF checkout can't fake a change.
const sha256 = (f) => createHash("sha256").update(fs.readFileSync(path.join(ROOT, f), "utf8").replace(/\r\n/g, "\n")).digest("hex");
const jsonl = (f) => fs.readFileSync(path.join(ROOT, f), "utf8").split(/\r?\n/).filter((l) => l.trim());

if (process.argv.includes("--write-manifest")) {
  const entries = Object.fromEntries(files().map((f) => [f, { sha256: sha256(f), ...(f.endsWith(".jsonl") ? { items: jsonl(f).length } : {}) }]));
  fs.writeFileSync(MANIFEST, JSON.stringify({ version: 1, frozen: new Date().toISOString().slice(0, 10), files: entries }, null, 2) + "\n");
  console.log(`wrote ${Object.keys(entries).length} entries to ${MANIFEST}`);
} else {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));

  test("every corpus file matches its frozen hash, and none was added or removed", () => {
    assert.deepEqual(files(), Object.keys(manifest.files).sort(), "corpora are frozen (D29): a new file or a removed one needs a new corpus version");
    for (const [f, { sha256: want }] of Object.entries(manifest.files)) assert.equal(sha256(f), want, `${f} changed; corpora are frozen (D29)`);
  });

  test("every JSONL line parses and each gated file keeps its L0 minimum", () => {
    for (const f of files().filter((x) => x.endsWith(".jsonl"))) for (const [i, l] of jsonl(f).entries()) assert.doesNotThrow(() => JSON.parse(l), `${f}:${i + 1}`);
    for (const [f, min] of Object.entries(MINIMUMS)) assert.ok(jsonl(f).length >= min, `${f}: ${jsonl(f).length} < ${min}`);
    const projects = fs.readdirSync(path.join(ROOT, "brief-relevance"), { withFileTypes: true }).filter((d) => d.isDirectory());
    assert.equal(projects.length, BRIEF_PROJECTS);
    for (const d of projects) for (const part of ["context.json", "notes.jsonl", "expected.json"]) assert.ok(fs.existsSync(path.join(ROOT, "brief-relevance", d.name, part)), `${d.name}/${part}`);
  });
}
