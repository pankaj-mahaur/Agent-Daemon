#!/usr/bin/env node
// Regenerate / check the committed codex app-server protocol snapshot.
//
//   node scripts/codex-schema-snapshot.mjs            write snapshot for the pinned codex
//   node scripts/codex-schema-snapshot.mjs --check    exit 1 if committed snapshot is stale
//   node scripts/codex-schema-snapshot.mjs --diff-md <file>
//        write a markdown diff (committed → pinned) to <file>, then update the
//        snapshot; exit 3 when the diff contains breaking changes (upgrade CI
//        uses this to label the PR, not to block it)

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { pinnedCodexVersion } from "../src/engine/codex/app-server.mjs";
import { diffSnapshots, diffToMarkdown, generateSnapshot } from "../src/engine/codex/protocol-snapshot.mjs";

const SNAPSHOT = fileURLToPath(new URL("../src/engine/codex/protocol-snapshot.json", import.meta.url));
const args = process.argv.slice(2);
const version = pinnedCodexVersion();
const fresh = generateSnapshot({ codexVersion: version });
const committed = existsSync(SNAPSHOT) ? JSON.parse(readFileSync(SNAPSHOT, "utf8")) : null;
const serialize = (s) => JSON.stringify(s, null, 2) + "\n";

if (args.includes("--check")) {
  if (committed && serialize(committed) === serialize(fresh)) {
    console.log(`protocol snapshot up to date (codex ${version})`);
    process.exit(0);
  }
  const d = committed ? diffSnapshots(committed, fresh) : { breaking: ["no committed snapshot"], info: [] };
  console.error(diffToMarkdown(d, committed?.codexVersion ?? "none", version));
  console.error("\nRun: node scripts/codex-schema-snapshot.mjs");
  process.exit(1);
}

const mdIdx = args.indexOf("--diff-md");
let exitCode = 0;
if (mdIdx !== -1) {
  const d = committed ? diffSnapshots(committed, fresh) : { breaking: [], info: ["initial snapshot"] };
  writeFileSync(args[mdIdx + 1], diffToMarkdown(d, committed?.codexVersion ?? "none", version) + "\n");
  if (d.breaking.length) exitCode = 3;
}
writeFileSync(SNAPSHOT, serialize(fresh));
console.log(`wrote ${SNAPSHOT} (codex ${version})`);
process.exit(exitCode);
