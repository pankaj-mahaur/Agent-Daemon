// P8.4b M1: the support matrix can't overstate. Every row's status is "tested live" or "built";
// every test or record its Evidence names exists; a "tested live" row names evidence of a real
// host (a test that starts the host, or an acceptance record), never only a fake.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const text = fs.readFileSync(path.join(ROOT, "docs", "support-matrix.md"), "utf8");
const section = text.split(/^## Hosts$/m)[1]?.split(/^## /m)[0] ?? "";
const rows = section
  .split(/\r?\n/)
  .filter((l) => /^\|/.test(l) && !/^\|\s*Host\s*\|/.test(l) && !/^\|\s*-/.test(l))
  .map((l) => l.split("|").map((c) => c.trim()))
  .map((c) => ({ host: c[1], route: c[2], status: c[3], evidence: c[4] ?? "" }));

export const evidenceFiles = (e) => [...e.matchAll(/`((?:runtime|docs|packages)\/[^`\s]+\.(?:mjs|md|json))`/g)].map((m) => m[1]);

test("the matrix has rows, each with a known status", () => {
  assert.ok(rows.length >= 5, `${rows.length}`);
  for (const r of rows) assert.ok(["tested live", "built"].includes(r.status), `${r.host} / ${r.route}: ${r.status}`);
});

test("every file a row cites as evidence exists", () => {
  for (const r of rows) for (const f of evidenceFiles(r.evidence)) assert.ok(fs.existsSync(path.join(ROOT, f)), `${r.host} / ${r.route}: ${f}`);
});

test("a tested-live row cites a real-host test or an acceptance record, not a fake host", () => {
  for (const r of rows.filter((x) => x.status === "tested live")) {
    const files = evidenceFiles(r.evidence);
    const real = files.some((f) => /acceptance|memory-host-|-real/.test(f)) || /acceptance record/i.test(r.evidence);
    assert.ok(real, `${r.host} / ${r.route} is "tested live" but cites only ${files.join(", ") || "nothing"}`);
    assert.doesNotMatch(r.evidence, /against a fake|owner acceptance pending/i, `${r.host}: a fake can't make a row tested live`);
  }
});
